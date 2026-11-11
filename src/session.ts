import type { TargetInfo } from './cdp.ts'
import type { Snapshot, SnapshotAction } from './snapshot.ts'

import { writeFile } from 'node:fs/promises'

import { browserInfo, CDP, listTargets } from './cdp.ts'
import { ChromeUseError, fail } from './errors.ts'
import { nodeExpression, resolveExpression, selectExpression, settleExpression, snapshotExpression } from './page.ts'
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
  private detach: () => void

  private constructor(cdp: CDP, sessionId: string, port: number, targetId: string) {
    this.cdp = cdp
    this.sessionId = sessionId
    this.port = port
    this.targetId = targetId
    this.detach = cdp.on((event) => {
      if (event.sessionId !== sessionId) return
      if (event.method === 'Page.javascriptDialogOpening') {
        this.dialogs++
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
      const value = await this.eval<Omit<Snapshot, 'dialogs'> | null>(snapshotExpression(limit))
      if (value) return { ...value, dialogs: this.dialogs }
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

  async click(ref: string): Promise<Snapshot> {
    await this.mouse(await this.point(ref))
    await this.settle(ref)
    return this.snap()
  }

  async type(ref: string, text: string): Promise<Snapshot> {
    await this.mouse(await this.point(ref))
    const modifier = process.platform === 'darwin' ? 4 : 2
    await this.cdp.send(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: modifier, commands: ['selectAll'] },
      this.sessionId,
    )
    await this.cdp.send(
      'Input.dispatchKeyEvent',
      { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: modifier },
      this.sessionId,
    )
    await this.cdp.send('Input.insertText', { text }, this.sessionId)
    await this.settle(ref)
    return this.snap()
  }

  async select(ref: string, value: string): Promise<Snapshot> {
    const result = await this.eval<{ reason?: string }>(selectExpression(ref, value))
    if (result.reason === 'gone') fail('STALE', `Element ${ref} is gone; take a new snapshot`)
    if (result.reason === 'not-select') fail('NOT_INTERACTABLE', `Element ${ref} is not a native select`)
    if (result.reason === 'no-option')
      fail('NOT_INTERACTABLE', `Element ${ref} has no option with value ${JSON.stringify(value)}`)
    await this.settle(ref)
    return this.snap()
  }

  async press(key: string): Promise<Snapshot> {
    const spec = KEYS[key]
    if (spec) await this.dispatchKey(key, spec)
    else if (key.length > 1) fail('NOT_INTERACTABLE', `Unknown key ${key}`)
    else {
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key }, this.sessionId)
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key }, this.sessionId)
    }
    // Enter and Space often submit, and the page can start moving a moment later.
    if (key === 'Enter' || key === ' ') {
      await this.waitForNavigation()
      await this.waitForReady(10)
    }
    return this.snap()
  }

  async upload(ref: string, files: string[]): Promise<Snapshot> {
    const evaluated = await this.cdp.send<{ result: { objectId?: string }; exceptionDetails?: unknown }>(
      'Runtime.evaluate',
      { expression: nodeExpression(ref), objectGroup: 'chrome-use' },
      this.sessionId,
    )
    const objectId = evaluated.result?.objectId
    if (!objectId) fail('STALE', `Element ${ref} is not on the page any more; take a new snapshot`)
    try {
      await this.cdp.send('DOM.setFileInputFiles', { files, objectId }, this.sessionId)
    } finally {
      await this.cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'chrome-use' }, this.sessionId).catch(() => {})
    }
    await this.settle(ref)
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

  private async dispatchKey(key: string, spec: KeySpec): Promise<void> {
    const base = { key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode }
    // Enter and Space only run their default action, such as submitting a form or
    // activating a button, when the key down carries text. Other keys work raw.
    if (spec.text) {
      await this.cdp.send(
        'Input.dispatchKeyEvent',
        { type: 'keyDown', ...base, text: spec.text, unmodifiedText: spec.text },
        this.sessionId,
      )
    } else {
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, this.sessionId)
    }
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, this.sessionId)
  }

  private remember(): void {
    const state = readState()
    if (state) writeState({ ...state, tab: this.targetId })
  }

  private async point(ref: string): Promise<Point> {
    const hit = await this.eval<TargetHit>(resolveExpression(ref))
    if (hit.reason === 'gone' || hit.reason === 'hidden') {
      fail('STALE', `Element ${ref} is not on the page any more; take a new snapshot`)
    }
    if (hit.reason) {
      fail('NOT_INTERACTABLE', `Element ${ref} cannot be clicked (${hit.reason}); take a new snapshot`)
    }
    const { x, y } = hit
    if (x == null || y == null) fail('NOT_INTERACTABLE', `Element ${ref} has no position; take a new snapshot`)
    return { x, y }
  }

  private async mouse(point: Point): Promise<void> {
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, this.sessionId)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.cdp.send(
        'Input.dispatchMouseEvent',
        { type, x: point.x, y: point.y, button: 'left', clickCount: 1 },
        this.sessionId,
      )
    }
  }

  private async settle(ref: string): Promise<void> {
    await this.eval(settleExpression(ref)).catch(() => {})
  }
}

/** Shorthand for `Session.connect`, which is what most scripts and the CLI use. */
export function connect(options: ConnectOptions = {}): Promise<Session> {
  return Session.connect(options)
}
