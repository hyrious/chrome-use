import type { CdpEvent } from './cdp.ts'
import type { Outcome } from './snapshot.ts'

import { delay } from './time.ts'

/**
 * Whether the page is still reacting. An action is settled when the document has
 * stopped loading, nothing it started is still in flight, and it has not changed
 * itself for the quiet window. Waiting on `readyState` alone misses an update an
 * XHR carries, which is most of them.
 *
 * The probe is page script, kept as text the way `page.ts` keeps its expressions,
 * so it reads the page rather than running in this process.
 */

/** How long the page has to stay still before an action counts as settled. */
const QUIET = 80

/** Upper bound on a settle, so a page that always animates cannot hang it. */
const CAP = 800

/** A request older than this is long polling or analytics, not the page reacting. */
const STALE_REQUEST = 1500

/** Requests that carry no page work: waiting for them waits for something endless. */
const IGNORED_REQUESTS: ReadonlySet<string> = new Set(['WebSocket', 'EventSource', 'Media', 'Ping', 'Manifest'])

/**
 * Errors a probe hits while the document is being replaced. They mean "ask again
 * on the new document"; nothing else does, so a real fault surfaces instead of
 * costing the whole cap.
 */
const NAVIGATING =
  /Execution context (was destroyed|not found)|Cannot find (context|default execution context)|Inspected target navigated|Target closed|No frame/

export function isNavigating(error: unknown): boolean {
  return error instanceof Error && NAVIGATING.test(error.message)
}

/** What the page reports about itself. */
export interface Probe {
  /** Milliseconds since the page last changed itself. */
  idle: number
  ready: DocumentReadyState
  url: string
  /** Monotonic count of DOM mutations and input events in this document. */
  changes: number
  /** Identity of the document being watched, so a navigation is not a mutation. */
  doc: string
}

/**
 * Installs the change observer on the first call and reports the running count.
 * The same-origin frames of a page are part of it, at any depth.
 */
export const PROBE = String.raw`(() => {
  const w = window
  const watch = (win, counted) => {
    const doc = win.document
    if (!doc.__chromeUseWatched) {
      doc.__chromeUseWatched = true
      // A style change counts once per element per window: a menu shown with
      // display counts, an animation loop that rewrites style every frame does not.
      const styled = new WeakMap()
      new MutationObserver((records) => {
        const time = performance.now()
        let real = false
        for (const record of records) {
          // Writing an attribute's current value back changes nothing.
          const same = record.attributeName != null &&
            record.oldValue === record.target.getAttributeNS(record.attributeNamespace, record.attributeName)
          if (same) continue
          if (record.attributeName !== 'style') real = true
          else if (time - (styled.get(record.target) || -1e9) > 200) real = true
          if (record.attributeName === 'style') styled.set(record.target, time)
        }
        if (real) {
          w.changed = time
          w.changes++
        }
      }).observe(doc, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true })
      for (const type of ['input', 'change']) win.addEventListener(type, () => w.changes++, true)
    }
    if (counted) {
      w.changed = performance.now()
      w.changes++
    }
  }

  if (!w.probe) {
    w.probe = true
    w.changed = performance.now()
    w.changes = 0
    w.doc = Math.random()
    watch(w, false)
  }

  // A frame document the probe has not seen yet counts as a change: it just navigated.
  const frames = (win, top) => {
    for (let index = 0; index < win.frames.length; index++) {
      let frame
      try {
        frame = win.frames[index]
        if (!frame.document) continue
      } catch (error) {
        continue
      }
      watch(frame, !top)
      frames(frame, false)
    }
  }
  frames(w, !!w.first)
  w.first = true

  return {
    idle: performance.now() - w.changed,
    ready: document.readyState,
    url: location.href,
    changes: w.changes,
    doc: w.doc,
  }
})()`

export interface SettleOptions {
  /** Upper bound on the wait, in milliseconds. */
  cap?: number
  /** When the action began, as a Date.now() timestamp, so quiet before it does not count. */
  since?: number
}

/** What `Liveness` needs from the tab it watches. */
export interface Page {
  evaluate<T>(expression: string): Promise<T>
}

/**
 * Tracks what one attached tab is doing, from the CDP events its session
 * forwards and from the page probe. `Session` owns one and does the talking to
 * the page; this owns what is known about whether the page has finished.
 */
export class Liveness {
  private readonly page: Page
  /** Requests the tab has started and not finished, by request id. */
  private readonly inflight = new Map<string, number>()
  /** When a request last finished, so a page that pauses between them stays busy. */
  private lastRequest = 0
  /** The last document load this tab failed, which is why a page is chrome-error. */
  private navError?: string

  constructor(page: Page) {
    this.page = page
  }

  /** Keeps the in-flight and failure state current from one CDP event. */
  observe(event: CdpEvent): void {
    if (!event.method.startsWith('Network.')) return
    const requestId = String(event.params.requestId ?? '')
    if (event.method === 'Network.requestWillBeSent') {
      if (event.params.type === 'Document') this.navError = undefined
      if (!IGNORED_REQUESTS.has(event.params.type as string)) this.inflight.set(requestId, Date.now())
      return
    }
    // A request ends when it finishes or fails, not when its response arrives:
    // a body still streaming is work the page is waiting for.
    if (event.method !== 'Network.loadingFinished' && event.method !== 'Network.loadingFailed') return
    if (event.method === 'Network.loadingFailed' && event.params.type === 'Document' && event.params.errorText) {
      this.navError = String(event.params.errorText)
    }
    this.inflight.delete(requestId)
    this.lastRequest = Date.now()
  }

  /** Reads the page. A navigation in progress reads as nothing rather than as an error. */
  async probe(): Promise<Probe | undefined> {
    try {
      return await this.page.evaluate<Probe>(PROBE)
    } catch (error) {
      if (isNavigating(error)) return undefined
      throw error
    }
  }

  /**
   * Waits until the page has finished reacting and returns what it looked like
   * then. A page that keeps animating or polling ends at the cap instead of
   * hanging; `waitForQuiet` is how a caller finds out that it did.
   */
  async settle(options: SettleOptions = {}): Promise<Probe | undefined> {
    const cap = options.cap ?? CAP
    const startedAt = Date.now()
    // Quiet observed before the action began proves nothing about the action.
    const began = options.since ?? startedAt
    let probe = await this.probe()
    while (Date.now() - startedAt < cap) {
      if (!probe) {
        await delay(40)
      } else {
        const quietFor = Math.min(probe.idle, Date.now() - began)
        const busy = this.inFlight() > 0 || Date.now() - this.lastRequest < QUIET
        if (probe.ready !== 'loading' && quietFor >= QUIET && !busy) return probe
        await delay(Math.max(20, QUIET - quietFor))
      }
      probe = await this.probe()
    }
    return probe
  }

  /** Resolves true when the page reached quiet within `cap` milliseconds. */
  async waitForQuiet(cap: number): Promise<boolean> {
    const probe = await this.settle({ cap })
    return probe != null && probe.ready !== 'loading' && probe.idle >= QUIET
  }

  /**
   * Says what an action did: a new document or url is a navigation, any other
   * mutation is a change, and neither is `none`. `before` is what the page looked
   * like when the action started.
   */
  outcome(before: Probe | undefined, after: Probe | undefined): Outcome {
    if (!before || !after) return { kind: 'changed', url: after?.url ?? before?.url ?? '' }
    if (after.doc !== before.doc || after.url !== before.url) {
      const outcome: Outcome = { kind: 'navigated', url: after.url }
      if (after.url.startsWith('chrome-error:') && this.navError) outcome.error = this.navError
      return outcome
    }
    return { kind: after.changes === before.changes ? 'none' : 'changed', url: after.url }
  }

  /** The network error behind Chrome's error page, such as ERR_NAME_NOT_RESOLVED. */
  get failure(): string | undefined {
    return this.navError
  }

  /** Requests that are plausibly this page reacting; a stale one is a socket left open. */
  private inFlight(): number {
    const now = Date.now()
    let count = 0
    for (const startedAt of this.inflight.values()) if (now - startedAt < STALE_REQUEST) count++
    return count
  }
}
