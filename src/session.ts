import type { TargetInfo } from './cdp.ts'
import type { Target } from './page.ts'
import type { Snapshot, SnapshotAction } from './snapshot.ts'

import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { browserInfo, CDP, listTargets } from './cdp.ts'
import { ChromeUseError, fail } from './errors.ts'
import {
  filesExpression,
  hitExpression,
  nodeExpression,
  parseTarget,
  readValueExpression,
  resolveExpression,
  selectExpression,
  settleExpression,
  snapshotExpression,
  textCheckExpression,
} from './page.ts'
import { readState, writeState } from './state.ts'
import { delay } from './time.ts'

export interface ConnectOptions {
  tab?: string
  port?: number
}

export interface SnapOptions {
  limit?: number
}

export interface ScreenshotOptions {
  full?: boolean
}

export interface IdleOptions {
  /** Cap in seconds; the wait resolves false when it expires. */
  maxTime?: number
}

export interface WaitOptions {
  /** Cap in seconds; the wait throws TIMEOUT when it expires. */
  maxTime?: number
}

export interface PointOptions {
  /** Describe what is under the point without pressing it. */
  dryRun?: boolean
}

export interface TabInfo {
  id: string
  url: string
  title: string
}

export interface Point {
  x: number
  y: number
}

interface KeySpec {
  code: string
  keyCode: number
  /** Text the key down must carry to run the default action, e.g. submit a form. */
  text?: string
}

interface TargetHit {
  x?: number
  y?: number
  reason?: string
}

/** A navigation belongs to the top frame when its frame has no parent. */
function isTopFrame(params: Record<string, unknown>): boolean {
  const { frame } = params as { frame?: { parentId?: string | null } }
  return frame?.parentId == null
}

/** Drops whitespace so a field that reformats what it was given still counts as filled. */
const squash = (value: string): string => value.replaceAll(/\s+/g, '')

const KEYS: Record<string, KeySpec> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
}

/** Bit flags the Input domain expects in `modifiers`. */
const MODIFIERS: Record<string, number> = {
  alt: 1,
  option: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  command: 4,
  cmd: 4,
  super: 4,
  shift: 8,
}

const ALIASES: Record<string, string> = { esc: 'Escape', return: 'Enter', space: ' ', del: 'Delete' }

/** Editor commands a synthetic chord has to name explicitly; key events alone do not run them. */
const COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo', y: 'redo' }

interface Chord {
  name: string
  modifiers: number
}

/** Reads `Control+a`, `Meta+Shift+z`, or a bare `Enter` into a key plus its modifier bits. */
function parseChord(key: string): Chord {
  const parts = key.split('+')
  const raw = parts.pop() ?? ''
  const name = ALIASES[raw.toLowerCase()] ?? raw
  if (!name) fail('NOT_INTERACTABLE', 'press needs a key')
  let modifiers = 0
  for (const part of parts) {
    const bit = MODIFIERS[part.toLowerCase()]
    if (bit == null) fail('NOT_INTERACTABLE', `Unknown modifier ${part} in ${key}`)
    modifiers |= bit
  }
  return { name, modifiers }
}

async function createPage(cdp: CDP): Promise<TargetInfo> {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
    background: true,
  })
  return { id: targetId, type: 'page', url: 'about:blank', title: '' }
}

function matchTarget(targets: TargetInfo[], wanted: string): TargetInfo | undefined {
  const byId = targets.find((target) => target.id === wanted)
  if (byId) return byId
  const byPrefix = targets.find((target) => target.id.startsWith(wanted))
  if (byPrefix) return byPrefix
  const index = Number(wanted)
  if (Number.isInteger(index)) return targets[index]
}

function pickTarget(targets: TargetInfo[], wanted?: string): TargetInfo {
  if (!wanted) {
    const first = targets[0]
    if (!first) fail('NO_TARGET', 'Chrome has no page tab open')
    return first
  }
  const found = matchTarget(targets, wanted)
  if (!found) fail('NO_TARGET', `No tab matches ${wanted}; run chrome-use status to list tabs`)
  return found
}

/** One attached tab: actions, snapshots, and the raw protocol behind them. */
export class Session {
  readonly port: number
  readonly cdp: CDP
  targetId: string
  private sessionId: string
  private dialogs = 0
  private dialog?: string
  private detach: () => void

  private constructor(cdp: CDP, sessionId: string, port: number, targetId: string) {
    this.cdp = cdp
    this.sessionId = sessionId
    this.port = port
    this.targetId = targetId
    this.detach = cdp.on((event) => {
      if (event.sessionId !== sessionId) return
      if (event.method === 'Page.javascriptDialogOpening') {
        // The page asked something. Accept it, like a user who pressed the button
        // expected, but keep the words: a tool that swallows a "delete everything?"
        // leaves the caller with no way to notice.
        const { type, message } = event.params as { type?: string; message?: string }
        this.dialogs++
        this.dialog = `${type ?? 'dialog'} ${JSON.stringify(message ?? '')}`
        cdp.send('Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {})
      }
    })
  }

  static async connect(options: ConnectOptions = {}): Promise<Session> {
    const state = readState()
    const port = options.port ?? state?.port ?? 9333
    const info = await browserInfo(port).catch(() => {
      fail('NOT_RUNNING', `Chrome is not listening on port ${port}; run: chrome-use start`)
    })
    const cdp = await CDP.open(info.webSocketDebuggerUrl)
    // A remembered tab may have been closed, and listTargets hides Chrome's internal pages.
    const targets = await listTargets(port)
    const remembered = options.tab ?? state?.tab
    const target = options.tab
      ? pickTarget(targets, options.tab)
      : (remembered && matchTarget(targets, remembered)) || targets[0] || (await createPage(cdp))
    const session = new Session(cdp, await cdp.attach(target.id), port, target.id)
    await session.enable()
    // The tab may still be loading a page the caller just opened.
    await session.waitForReady(10)
    return session
  }

  /** Raw CDP on the current tab. Every method is available, no wrapper needed. */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.cdp.send<T>(method, params, this.sessionId)
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const result = await this.cdp.send<{
      exceptionDetails?: { exception?: { description?: string }; text?: string }
      result?: { value?: unknown }
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, this.sessionId)
    const details = result.exceptionDetails
    if (details) {
      fail('EVAL_ERROR', details.exception?.description ?? details.text ?? 'evaluation failed')
    }
    return result.result?.value as T
  }

  async snap(options: SnapOptions = {}): Promise<Snapshot> {
    const limit = options.limit ?? 250
    for (let attempt = 0; attempt < 20; attempt++) {
      const value = await this.eval<Omit<Snapshot, 'dialogs' | 'dialog'> | null>(snapshotExpression(limit))
      if (value) return { ...value, dialogs: this.dialogs, ...(this.dialog ? { dialog: this.dialog } : {}) }
      await delay(50)
    }
    fail('STALE', 'The page never settled; take a new snapshot')
  }

  async open(url: string): Promise<Snapshot> {
    await this.cdp.send('Page.navigate', { url }, this.sessionId, 15_000).catch(async (error) => {
      if (error instanceof ChromeUseError && error.code === 'TIMEOUT') {
        await this.stopLoading()
        fail(
          'NETWORK',
          `Navigating to ${url} never answered; the browser cannot reach the network. If it needs a proxy, restart it: chrome-use stop && chrome-use start -x <proxy>`,
        )
      }
      throw error
    })
    await this.waitForReady(15)
    // Chrome keeps the scroll position when the same url is opened twice, which
    // hides the top of the page from the next snapshot.
    await this.eval('window.scrollTo(0, 0)').catch(() => {})
    const landed = await this.eval<string>('location.href').catch(() => '')
    if (landed.startsWith('chrome-error://')) {
      await this.stopLoading()
      fail(
        'NETWORK',
        `Chrome cannot load ${url}; it shows an error page. If the network needs a proxy, restart it: chrome-use stop && chrome-use start -x <proxy>`,
      )
    }
    return this.snap()
  }

  /** Resolves once the document and its readable frames report complete, or maxTime passes. */
  async waitForReady(maxTime = 3): Promise<void> {
    const ready = `document.readyState == 'complete' && [...document.querySelectorAll('iframe')].every((frame) => {
      try {
        return !frame.contentDocument || frame.contentDocument.readyState == 'complete'
      } catch (error) {
        return true
      }
    })`
    const deadline = Date.now() + maxTime * 1000
    while (Date.now() < deadline) {
      if (await this.eval<boolean>(ready).catch(() => true)) return
      await delay(50)
    }
  }

  async click(target: string): Promise<Snapshot> {
    const wanted = parseTarget(target)
    await this.mouse(await this.pointOf(wanted))
    await this.settle(wanted)
    return this.snap()
  }

  async type(target: string, text: string): Promise<Snapshot> {
    const wanted = parseTarget(target)
    const name = 'ref' in wanted ? wanted.ref : wanted.selector
    const check = await this.eval<{ reason?: string; max?: number }>(textCheckExpression(wanted, text))
    if (check.reason === 'gone') fail('STALE', `Element ${name} is not on the page any more; take a new snapshot`)
    if (check.reason === 'bad-selector') fail('NOT_INTERACTABLE', `${name} is not a valid CSS selector`)
    if (check.reason === 'disabled') fail('NOT_INTERACTABLE', `Element ${name} is disabled`)
    if (check.reason === 'readonly') fail('NOT_INTERACTABLE', `Element ${name} is read only`)
    if (check.reason === 'not-text')
      fail('NOT_INTERACTABLE', `Element ${name} does not take text; use click, upload or select`)
    if (check.reason === 'structured')
      fail('NOT_INTERACTABLE', `Element ${name} is a segmented date field; set its value with eval instead of typing`)
    if (check.reason === 'too-long') fail('NOT_INTERACTABLE', `Element ${name} accepts at most ${check.max} characters`)
    await this.mouse(await this.pointOf(wanted))
    // Select what is already there first, so typing replaces instead of appending.
    // An empty text clears the field, which is the only way to say "no value".
    const selectAll = process.platform === 'darwin' ? 'Meta+a' : 'Control+a'
    await this.dispatchChord(parseChord(selectAll))
    if (text) await this.cdp.send('Input.insertText', { text }, this.sessionId)
    else await this.dispatchChord(parseChord('Backspace'))
    await this.settle(wanted)
    // Text a controlled input drops is a failed fill, not a filled field.
    const read = await this.eval<{ value?: string; secret?: boolean }>(readValueExpression(wanted))
    if (read.value !== undefined && squash(read.value) !== squash(text)) {
      const shown = read.secret ? '•'.repeat(read.value.length) : read.value.slice(0, 60)
      fail('INPUT_MISMATCH', `Element ${name} shows ${JSON.stringify(shown)} after typing; the page changed the value`)
    }
    return this.snap()
  }

  /** Moves the pointer over a target and leaves it there, for menus that open on hover. */
  async hover(target: string): Promise<Snapshot> {
    const wanted = parseTarget(target)
    await this.mouse(await this.pointOf(wanted), true)
    await this.settle(wanted)
    return this.snap()
  }

  /**
   * Clicks a point in the viewport, for what the element table cannot see: a
   * canvas, a drawing, an unnamed SVG. The snapshot says what the point landed
   * on, and a dry run reports it without pressing anything.
   */
  async point(x: number, y: number, options: PointOptions = {}): Promise<Snapshot> {
    const viewport = await this.eval<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })')
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= viewport.w || y >= viewport.h)
      fail(
        'NOT_INTERACTABLE',
        `Point ${x},${y} is outside the ${viewport.w} by ${viewport.h} viewport; take a new screenshot`,
      )
    const hit = await this.eval<string | null>(hitExpression(x, y))
    if (!hit) fail('NOT_INTERACTABLE', `Nothing is at ${x},${y}; take a new screenshot`)
    if (!options.dryRun) await this.mouse({ x, y })
    const snap = await this.snap()
    return { ...snap, hit }
  }

  async select(target: string, value: string): Promise<Snapshot> {
    const wanted = parseTarget(target)
    const result = await this.eval<{ reason?: string }>(selectExpression(wanted, value))
    if (result.reason === 'gone') fail('STALE', `Element ${target} is gone; take a new snapshot`)
    if (result.reason === 'bad-selector') fail('NOT_INTERACTABLE', `${target} is not a valid CSS selector`)
    if (result.reason === 'not-select') fail('NOT_INTERACTABLE', `Element ${target} is not a native select`)
    if (result.reason === 'no-option')
      fail('NOT_INTERACTABLE', `Element ${target} has no option with value ${JSON.stringify(value)}`)
    await this.settle(wanted)
    // A controlled select can put the old option back after the events fired.
    const read = await this.eval<{ value?: string }>(readValueExpression(wanted))
    if (read.value !== undefined && read.value !== value)
      fail(
        'INPUT_MISMATCH',
        `Element ${target} shows ${JSON.stringify(read.value.slice(0, 60))} after selecting; the page did not keep it`,
      )
    return this.snap()
  }

  async press(key: string): Promise<Snapshot> {
    const chord = parseChord(key)
    await this.dispatchChord(chord)
    // Enter and Space often submit, and the page can start moving a moment later.
    if (chord.name === 'Enter' || chord.name === ' ') {
      await this.waitForNavigation()
      await this.waitForReady(10)
    }
    return this.snap()
  }

  /** A ref from snap, or a CSS selector when the snapshot never listed the node. */
  async upload(target: string, files: string[]): Promise<Snapshot> {
    const wanted = parseTarget(target)
    const evaluated = await this.cdp.send<{ result: { objectId?: string }; exceptionDetails?: unknown }>(
      'Runtime.evaluate',
      { expression: nodeExpression(wanted), objectGroup: 'chrome-use' },
      this.sessionId,
    )
    const objectId = evaluated.result?.objectId
    if (!objectId) fail('STALE', `Element ${target} is not on the page any more; take a new snapshot`)
    try {
      await this.cdp.send('DOM.setFileInputFiles', { files, objectId }, this.sessionId)
    } finally {
      await this.cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'chrome-use' }, this.sessionId).catch(() => {})
    }
    await this.settle(wanted)
    const attached = await this.eval<{ names?: string[]; reason?: string }>(filesExpression(wanted))
    if (attached.reason === 'not-file') fail('NOT_INTERACTABLE', `Element ${target} is not a file input`)
    const expected = files.map((file) => basename(file))
    const actual = attached.names ?? []
    if (actual.length !== expected.length || expected.some((name, index) => name !== actual[index]))
      fail(
        'INPUT_MISMATCH',
        `Element ${target} holds ${JSON.stringify(actual)} after the upload; the page did not keep the file(s)`,
      )
    return this.snap()
  }

  /** Runs one action that came from a snapshot or a decision. */
  async act(action: SnapshotAction, text?: string): Promise<Snapshot> {
    if (action.kind === 'click') return this.click(action.ref)
    if (action.kind === 'select') return this.select(action.ref, action.value)
    if (typeof text !== 'string') fail('NEEDS_TEXT', `No text to type into ${action.label}`)
    return this.type(action.ref, text)
  }

  /** Resolves true on network idle, false when maxTime seconds pass first. */
  waitForIdle(options: IdleOptions = {}): Promise<boolean> {
    const maxTime = options.maxTime ?? 3
    const timeout = new Promise<boolean>((done) => setTimeout(() => done(false), maxTime * 1000))
    return Promise.race([this.waitForNetworkIdle(), timeout])
  }

  /** Polls the page until `expression` is truthy. */
  async waitFor<T = unknown>(expression: string, options: WaitOptions = {}): Promise<T> {
    return this.poll<T>(expression, (value) => value != null && value !== false && value !== '', options)
  }

  /** Polls until location.href equals `wanted`, or matches the expression. */
  async waitForURL(wanted: string | RegExp, options: WaitOptions = {}): Promise<void> {
    const pattern = typeof wanted === 'string' ? undefined : new RegExp(wanted.source, wanted.flags)
    await this.poll(
      'location.href',
      (value) => typeof value === 'string' && (pattern ? pattern.test(value) : value === wanted),
      options,
    )
  }

  /** Polls until the page text contains `text`. */
  async waitForText(text: string, options: WaitOptions & { exact?: boolean } = {}): Promise<void> {
    const wanted = text.replaceAll(/\s+/g, ' ').trim().toLowerCase()
    await this.poll(
      '(document.body ? document.body.innerText : "").replace(/\\s+/g, " ").trim()',
      (value) => {
        const page = typeof value === 'string' ? value.toLowerCase() : ''
        return options.exact ? page === wanted : page.includes(wanted)
      },
      options,
    )
  }

  private async poll<T = unknown>(
    expression: string,
    done: (value: unknown) => boolean,
    options: WaitOptions = {},
  ): Promise<T> {
    const maxTime = options.maxTime ?? 10
    const deadline = Date.now() + maxTime * 1000
    while (true) {
      const value = await this.eval<T>(expression).catch(() => undefined)
      if (done(value)) return value as T
      if (Date.now() >= deadline) fail('TIMEOUT', `The page did not reach the expected state within ${maxTime}s`)
      await delay(200)
    }
  }

  async screenshot(file?: string, options: ScreenshotOptions = {}): Promise<Buffer> {
    const shot = await this.cdp.send<{ data: string }>(
      'Page.captureScreenshot',
      options.full ? await this.fullPageParams() : { format: 'png' },
      this.sessionId,
    )
    const buffer = Buffer.from(shot.data, 'base64')
    if (file) await writeFile(file, buffer)
    return buffer
  }

  async tabs(): Promise<TabInfo[]> {
    const targets = await listTargets(this.port)
    return targets.map((target) => ({ id: target.id, url: target.url, title: target.title }))
  }

  /** Closes a tab, the attached one by default. */
  async closeTab(targetId = this.targetId): Promise<void> {
    await this.cdp.send('Target.closeTarget', { targetId })
    const state = readState()
    if (state && state.tab === targetId) writeState({ ...state, tab: undefined })
  }

  async use(tab: string): Promise<void> {
    const target = pickTarget(await listTargets(this.port), tab)
    this.sessionId = await this.cdp.attach(target.id)
    this.targetId = target.id
    await this.enable()
    this.remember()
  }

  close(): void {
    this.detach()
    this.cdp.close()
  }

  /** Resolves when the tab starts a top level navigation, or when maxTime seconds pass. */ private waitForNavigation(
    maxTime = 0.8,
  ): Promise<void> {
    return new Promise((done) => {
      let off = () => {}
      const timer = setTimeout(() => {
        off()
        done()
      }, maxTime * 1000)
      off = this.cdp.on((event) => {
        if (event.sessionId !== this.sessionId) return
        if (event.method === 'Page.frameNavigated' && isTopFrame(event.params)) {
          clearTimeout(timer)
          off()
          done()
        }
      })
    })
  }

  private async stopLoading(): Promise<void> {
    await this.cdp.send('Page.stopLoading', {}, this.sessionId).catch(() => {})
  }

  private async enable(): Promise<void> {
    await this.cdp.send('DOM.enable', {}, this.sessionId)
    await this.cdp.send('Page.enable', {}, this.sessionId)
    await this.cdp.send('Runtime.enable', {}, this.sessionId)
    // Page focus is independent of the user's active window and keyboard focus.
    await this.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, this.sessionId)
    await this.cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, this.sessionId)
  }

  private waitForNetworkIdle(): Promise<boolean> {
    return new Promise((resolve) => {
      let off = () => {}
      off = this.cdp.on((event) => {
        if (event.sessionId !== this.sessionId) return
        if (event.method === 'Page.lifecycleEvent' && event.params.name === 'networkIdle') {
          off()
          resolve(true)
        }
      })
    })
  }

  private async fullPageParams(): Promise<Record<string, unknown>> {
    const metrics = await this.cdp.send<{ cssContentSize: { width: number; height: number } }>(
      'Page.getLayoutMetrics',
      {},
      this.sessionId,
    )
    const { width, height } = metrics.cssContentSize
    return { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } }
  }

  private async dispatchChord(chord: Chord): Promise<void> {
    const spec = KEYS[chord.name]
    const base: Record<string, unknown> = { key: chord.name, modifiers: chord.modifiers }
    if (spec) {
      base.code = spec.code
      base.windowsVirtualKeyCode = spec.keyCode
      base.nativeVirtualKeyCode = spec.keyCode
      // Enter and Space only run their default action, such as submitting a form or
      // activating a button, when the key down carries text. Other keys work raw.
      if (spec.text && !chord.modifiers) {
        base.text = spec.text
        base.unmodifiedText = spec.text
      }
    } else if (chord.name.length === 1) {
      if (/[a-z]/i.test(chord.name)) base.code = `Key${chord.name.toUpperCase()}`
      else if (/[0-9]/.test(chord.name)) base.code = `Digit${chord.name}`
      if (!chord.modifiers) base.text = chord.name
    } else {
      fail('NOT_INTERACTABLE', `Unknown key ${chord.name}`)
    }
    const command = chord.modifiers ? COMMANDS[chord.name.toLowerCase()] : undefined
    if (command) base.commands = [command]
    await this.cdp.send(
      'Input.dispatchKeyEvent',
      { type: base.text ? 'keyDown' : 'rawKeyDown', ...base },
      this.sessionId,
    )
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, this.sessionId)
  }

  private remember(): void {
    const state = readState()
    if (state) writeState({ ...state, tab: this.targetId })
  }

  private async pointOf(target: Target): Promise<Point> {
    const hit = await this.eval<TargetHit>(resolveExpression(target))
    const name = 'ref' in target ? target.ref : target.selector
    if (hit.reason === 'gone' || hit.reason === 'hidden') {
      fail('STALE', `Element ${name} is not on the page any more; take a new snapshot`)
    }
    if (hit.reason === 'bad-selector') fail('NOT_INTERACTABLE', `${name} is not a valid CSS selector`)
    if (hit.reason) {
      fail('NOT_INTERACTABLE', `Element ${name} cannot be clicked (${hit.reason}); take a new snapshot`)
    }
    const { x, y } = hit
    if (x == null || y == null) fail('NOT_INTERACTABLE', `Element ${name} has no position; take a new snapshot`)
    return { x, y }
  }

  private async mouse(point: Point, hover = false): Promise<void> {
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, this.sessionId)
    if (hover) return
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.cdp.send(
        'Input.dispatchMouseEvent',
        { type, x: point.x, y: point.y, button: 'left', clickCount: 1 },
        this.sessionId,
      )
    }
  }

  private async settle(target: Target): Promise<void> {
    await this.eval(settleExpression(target)).catch(() => {})
  }
}

/** Shorthand for `Session.connect`, which is what most scripts and the CLI use. */
export function connect(options: ConnectOptions = {}): Promise<Session> {
  return Session.connect(options)
}
