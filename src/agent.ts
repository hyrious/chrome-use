import type { ControlAction } from './actions.ts'
import type { Decision, HistoryEntry, ModelConfig, SystemOneRequest } from './decide.ts'
import type { Session, TabInfo } from './session.ts'
import type { Outcome, Snapshot, SnapshotAction } from './snapshot.ts'

import { collectActions } from './actions.ts'
import { buildRequest, endpointOf, postJson, readDecision, readTextAnswer } from './decide.ts'
import { ChromeUseError, fail } from './errors.ts'
import { TEXT_VALUE } from './questions.ts'
import { delay } from './time.ts'

export interface StepInfo {
  step: number
  request: SystemOneRequest
  operation: string
  action?: string
  text?: string | null
  needs?: NeedsInput
  pageChanged?: boolean
  confidence?: number
  latencyMs?: number
}

export interface RunOptions {
  jev: ModelConfig
  /** OpenAI compatible model used only when a field needs a value. */
  text?: ModelConfig
  /** Text model and JEV both may read this. */
  goal: string
  /** JEV max requests, default 20. */
  maxSteps?: number
  /** Field values to type, keyed by the field label. Avoids the extra text model call. */
  fills?: Record<string, string>
  /** File paths to attach, keyed by the field label. */
  uploads?: Record<string, string[]>
  /** Recent actions sent as JEV deciding context. */
  history?: HistoryEntry[]
  /** Max possible actions generated for JEV to choose from, default 250. */
  limit?: number
  /** Show the first request that will be sent to text model or JEV. */
  dryRun?: boolean
  onStep?: (step: StepInfo) => void
}

export interface RunResult {
  status: 'done' | 'blocked' | 'needs' | 'max-steps' | 'dry-run'
  steps: number
  url: string
  verified: false
  history: HistoryEntry[]
  needs?: NeedsInput
  /** Set when the page itself explains why the run cannot continue. */
  hint?: string
  request?: SystemOneRequest
}

export interface NeedsInput {
  kind: 'text' | 'file'
  ref: string
  label: string
}

interface StepState {
  snap: Snapshot
  /** Fingerprint of `snap`, so a step does not hash the same page twice. */
  key: string
  history: HistoryEntry[]
  steps: number
  retried: boolean
  visits: Map<string, number>
}

interface AdvanceInput {
  session: Session
  decision: Decision
  text: string | undefined
  files: string[] | undefined
  limit: number
  previousUrl: string
}

interface Advanced {
  snap: Snapshot
  /** What the step did to the page, or null for a control, which is progress by definition. */
  outcome: Outcome | null
}

const LOOP_HINT =
  'the run keeps returning to the same page; the goal may need a different starting point, or the site hides the choice behind a step the loop cannot take'

const BLOCKED_HINTS: Array<[RegExp, string]> = [
  [
    /captcha|验证码|安全验证|人机验证|verify (that )?you are|are you a robot|unusual traffic|checking your browser/i,
    'the page is a verification screen; ask the user to finish it in the browser, then run again',
  ],
  [
    /sign in to continue|log in to continue|请登录|登录后(继续|查看)|登录以继续/i,
    'the page wants a signed in session; ask the user to sign in in this Chrome window, then run again',
  ],
]

function hintFor(snap: Snapshot): string | undefined {
  for (const [pattern, hint] of BLOCKED_HINTS) {
    if (pattern.test(snap.text)) return hint
  }
  if (snap.hiddenFrames) {
    return `${snap.hiddenFrames} frame(s) here come from another origin, so the loop cannot see the control. Ask the user, or drive it with chrome-use js and chrome-use cdp.`
  }
  // The closed choice set is deliberately smaller than the browser: say so instead
  // of growing it until every page has a matching operation.
  return 'the offered operations cannot express this step; snapshot the page and script it with chrome-use js, or click a ref yourself'
}

function fingerprint(snap: Snapshot): string {
  const elements = snap.elements.map((element) =>
    [element.ref, element.label, element.value, element.checked].join(':'),
  )
  return JSON.stringify([snap.url, snap.title, snap.text, elements])
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[*:：]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function matchKey<T>(entries: Record<string, T>, label: string): T | undefined {
  const wanted = normalize(label)
  for (const [key, value] of Object.entries(entries)) {
    if (normalize(key) === wanted) return value
  }
  for (const [key, value] of Object.entries(entries)) {
    const candidate = normalize(key)
    if (candidate && (wanted.includes(candidate) || candidate.includes(wanted))) return value
  }
}

function askTextModel(
  config: ModelConfig,
  goal: string,
  action: SnapshotAction,
  snap: Snapshot,
  history: HistoryEntry[],
): Promise<string | null> {
  const element = snap.elements.find((element) => element.ref === action.ref)
  const body = {
    model: config.model,
    max_tokens: 1024,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: TEXT_VALUE },
      {
        role: 'user',
        content: JSON.stringify({
          goal,
          field: { label: action.label, value: action.value, role: element?.role, context: element?.context },
          page: { url: snap.url, title: snap.title, text: snap.text.slice(0, 6000) },
          recent_actions: history.slice(-6),
        }),
      },
    ],
  }
  return postJson(endpointOf(config.baseUrl, '/chat/completions'), config.apiKey, body, config.timeout).then(
    readTextAnswer,
  )
}

async function textFor(
  options: RunOptions,
  action: SnapshotAction,
  snap: Snapshot,
  history: HistoryEntry[],
): Promise<string | null> {
  const filled = matchKey(options.fills ?? {}, action.label)
  if (filled != null) return filled
  if (!options.text) return null
  return askTextModel(options.text, options.goal, action, snap, history)
}

/** A target=_blank tab appears a moment after the click, so the list is polled briefly. */
async function pollNewTabs(session: Session, before: Set<string>): Promise<TabInfo[]> {
  const deadline = Date.now() + 600
  while (Date.now() < deadline) {
    const opened = (await session.tabs()).filter((tab) => !before.has(tab.id))
    if (opened.length) return opened
    await delay(100)
  }
  return []
}

async function runControl(session: Session, control: ControlAction, limit: number): Promise<Advanced> {
  if (control.kind === 'switch') await session.use(control.tabId)
  else if (control.kind === 'scroll') await session.eval(`window.scrollBy(0, ${control.delta})`)
  else if (control.kind === 'back') {
    await session.eval('history.back()')
    await session.waitForReady(5)
  } else await session.waitForIdle({ maxTime: 2 })
  const snap = await session.snap({ limit })
  // A scroll changes what is visible without changing the page, so no probe can
  // say whether it worked. A control is progress until the page says otherwise.
  return { snap, outcome: null }
}

async function advance({ session, decision, text, files, limit, previousUrl }: AdvanceInput): Promise<Advanced> {
  try {
    if (decision.control) return await runControl(session, decision.control, limit)
    const action = decision.action
    if (!action) fail('INVALID_DECISION', `The decision for ${decision.operation} carries no action or control to run`)
    const before = new Set((await session.tabs()).map((tab) => tab.id))
    const next = files ? await session.upload(action.ref, files) : await session.act(action, text)
    // A target=_blank link leaves the current page alone, so the tab it opens is followed.
    const opened = (await session.tabs()).filter((tab) => !before.has(tab.id))
    if (!opened.length && next.url === previousUrl) opened.push(...(await pollNewTabs(session, before)))
    if (opened.length === 1) {
      await session.use(opened[0].id)
      await session.waitForReady(3)
      const snap = await session.snap({ limit })
      return { snap, outcome: { kind: 'navigated', url: snap.url } }
    }
    if (next.url !== previousUrl) {
      await session.waitForReady(3)
      const snap = await session.snap({ limit })
      return { snap, outcome: { kind: 'navigated', url: snap.url } }
    }
    return { snap: next, outcome: next.outcome ?? { kind: 'changed', url: next.url } }
  } catch (error) {
    if (error instanceof ChromeUseError && (error.code === 'STALE' || error.code === 'NOT_INTERACTABLE')) {
      const snap = await session.snap({ limit })
      return { snap, outcome: { kind: 'none', url: snap.url } }
    }
    throw error
  }
}

function result(status: RunResult['status'], state: StepState, url: string, extra: Partial<RunResult> = {}): RunResult {
  return { status, steps: state.steps, url, verified: false, history: state.history, ...extra }
}

function historyEntry(decision: Decision, text: string | undefined, next: Snapshot, changed: boolean): HistoryEntry {
  return {
    action: decision.action?.label ?? decision.control?.label ?? decision.operation,
    kind: decision.action?.kind ?? decision.control?.kind ?? 'unknown',
    text: text ?? null,
    page_changed: changed,
    url: next.url,
  }
}

function stuck(history: HistoryEntry[]): boolean {
  const recent = history.slice(-3)
  return recent.length === 3 && recent.every((entry) => entry.page_changed === false && entry.kind !== 'wait')
}

/**
 * Drives the page toward a goal, one decision at a time. The model picks from the
 * offered options; this function never lets it invent a target or a parameter.
 */
export async function run(session: Session, options: RunOptions): Promise<RunResult> {
  const maxSteps = options.maxSteps ?? 20
  const limit = options.limit ?? 250
  const first = await session.snap({ limit })
  const state: StepState = {
    snap: first,
    key: fingerprint(first),
    history: options.history ? options.history.slice() : [],
    steps: 0,
    retried: false,
    visits: new Map(),
  }
  state.visits.set(state.key, 1)

  while (state.steps < maxSteps) {
    state.steps++
    const table = collectActions(state.snap, { tabs: await session.tabs(), current: session.targetId })
    const request = buildRequest({
      goal: options.goal,
      snap: state.snap,
      table,
      history: state.history,
      model: options.jev.model,
    })
    if (options.dryRun) {
      return result('dry-run', state, state.snap.url, { steps: state.steps - 1, request })
    }

    const started = Date.now()
    const response = await postJson(
      endpointOf(options.jev.baseUrl, '/systemone'),
      options.jev.apiKey,
      request,
      options.jev.timeout,
    )
    const decision = readDecision(response, table)
    const latencyMs = Date.now() - started

    // A page that is still loading looks blocked, so the first BLOCKED only waits.
    if (decision.kind === 'blocked' && !state.retried) {
      state.retried = true
      options.onStep?.({
        step: state.steps,
        request,
        operation: decision.operation,
        confidence: decision.confidence,
        latencyMs,
      })
      await session.waitForIdle({ maxTime: 3 })
      state.snap = await session.snap({ limit })
      continue
    }
    if (decision.kind !== 'action') {
      options.onStep?.({
        step: state.steps,
        request,
        operation: decision.operation,
        confidence: decision.confidence,
        latencyMs,
      })
      return result(decision.kind, state, state.snap.url, {
        hint: decision.kind === 'blocked' ? hintFor(state.snap) : undefined,
      })
    }

    let text: string | undefined
    let files: string[] | undefined
    if (decision.action?.kind === 'upload') {
      files = decision.action ? matchKey(options.uploads ?? {}, decision.action.label) : undefined
      if (!files) {
        const needs: NeedsInput = { kind: 'file', ref: decision.action.ref, label: decision.action.label }
        options.onStep?.({
          step: state.steps,
          request,
          operation: decision.operation,
          action: decision.action.label,
          needs,
          latencyMs,
        })
        return result('needs', state, state.snap.url, { needs })
      }
    }
    if (decision.action?.kind === 'fill') {
      const value = await textFor(options, decision.action, state.snap, state.history)
      if (value === null) {
        const needs: NeedsInput = { kind: 'text', ref: decision.action.ref, label: decision.action.label }
        options.onStep?.({
          step: state.steps,
          request,
          operation: decision.operation,
          action: decision.action.label,
          needs,
          latencyMs,
        })
        return result('needs', state, state.snap.url, { needs })
      }
      text = value
    }

    const next = await advance({ session, decision, text, files, limit, previousUrl: state.snap.url })
    const nextKey = fingerprint(next.snap)
    const record = historyEntry(decision, text, next.snap, next.outcome === null || next.outcome.kind !== 'none')
    if (files) record.text = files.join(', ')
    state.history.push(record)
    options.onStep?.({
      step: state.steps,
      request,
      operation: decision.operation,
      action: record.action,
      text: record.text,
      pageChanged: record.page_changed ?? undefined,
      confidence: decision.confidence,
      latencyMs,
    })

    // A run that keeps returning to the same page is looping, for example a click
    // followed by a back that undoes it.
    const visits = (state.visits.get(nextKey) ?? 0) + 1
    state.visits.set(nextKey, visits)
    if (visits >= 3) {
      return result('blocked', state, next.snap.url, { hint: LOOP_HINT })
    }
    if (stuck(state.history)) {
      return result('blocked', state, next.snap.url, { hint: hintFor(next.snap) })
    }
    state.snap = next.snap
    state.key = nextKey
  }

  return result('max-steps', state, state.snap.url)
}
