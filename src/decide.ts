import type { ActionTable, ControlAction, ElementEntry, Operation } from './actions.ts'
import type { ScrollState, Snapshot, SnapshotAction } from './snapshot.ts'

import { fail } from './errors.ts'
import { NEXT_ACTION, TARGET } from './questions.ts'

export const DEFAULT_MODEL = 'typesafe/jev'

const OPERATIONS: readonly Operation[] = ['CLICK', 'TYPE_TEXT', 'SELECT', 'UPLOAD']

const OPERATION_LABELS: Record<Operation, string> = {
  CLICK: 'Click an element, button, link, menu option, autocomplete suggestion, or calendar day.',
  TYPE_TEXT: 'Enter text in an editable field. A separate model supplies the value from the goal.',
  SELECT: 'Select an observed dropdown value.',
  UPLOAD: 'Attach a file to a file field. The caller supplies the path.',
}

export interface HistoryEntry {
  action: string
  kind: string
  text?: string | null
  page_changed: boolean | null
  url?: string
}

export interface Viewport {
  w: number
  h: number
}

export interface PageState {
  url: string
  title: string
  text: string
  viewport: Viewport
  scroll: ScrollState
}

export interface RequestState {
  page: PageState
  elements: ElementEntry[]
  recent_actions: HistoryEntry[]
}

export interface ChoiceInstructions {
  goal: string
  operation?: string
  rules: string | string[]
}

export interface ChoiceQuestion {
  type: 'choice'
  criteria: Record<string, unknown>
  instructions: ChoiceInstructions
}

export interface SystemOneRequest {
  model: string
  state: RequestState
  questions: Record<string, ChoiceQuestion>
}

export interface BuildRequestOptions {
  goal: string
  snap: Snapshot
  table: ActionTable
  history?: HistoryEntry[]
  model?: string
}

export interface ChoiceAnswer {
  choice: string
  confidence: number
  probabilities: Record<string, number>
}

export interface Decision {
  kind: 'action' | 'done' | 'blocked'
  operation: string
  confidence: number
  probabilities: Record<string, number>
  action?: SnapshotAction
  control?: ControlAction
}

export interface ModelConfig {
  baseUrl: string
  apiKey: string
  model: string
  timeout?: number
}

/** True when the operation has at least one target, without building the key array to count it. */
function hasTargets(table: ActionTable, operation: Operation): boolean {
  for (const _ in table.targets[operation]) return true
  return false
}

function operationCriteria(table: ActionTable): Record<string, string> {
  const criteria: Record<string, string> = {}
  for (const operation of OPERATIONS) {
    if (hasTargets(table, operation)) criteria[operation] = OPERATION_LABELS[operation]
  }
  for (const control of Object.values(table.controls)) criteria[control.key] = control.label
  criteria.DONE = 'Every requirement is visibly satisfied.'
  criteria.BLOCKED = 'No offered operation can make progress.'
  return criteria
}

function targetEntry(action: SnapshotAction, elements: Map<string, ElementEntry>): Record<string, unknown> {
  const entry: Record<string, unknown> = { element: `[${action.ref}] ${action.label}` }
  const value = action.kind === 'fill' ? action.value : action.current_value
  if (value) entry.current_value = value
  const known = elements.get(action.ref)
  const context = known?.context
  if (context) entry.context = context
  for (const key of ['checked', 'selected', 'expanded'] as const) {
    if (known?.[key]) entry[key] = known[key]
  }
  return entry
}

function targetCriteria(
  operation: Operation,
  table: ActionTable,
  goal: string,
  elements: Map<string, ElementEntry>,
): ChoiceQuestion {
  const criteria: Record<string, unknown> = {}
  for (const [index, action] of Object.entries(table.targets[operation])) {
    criteria[index] = targetEntry(action, elements)
  }
  return {
    type: 'choice',
    criteria,
    instructions: { goal, operation, rules: [NEXT_ACTION, TARGET] },
  }
}

/**
 * Builds the request sent to the decision endpoint. Every option is enumerated
 * here, so an answer can only be one of the offered choices.
 */
export function buildRequest(options: BuildRequestOptions): SystemOneRequest {
  const { goal, snap, table, history = [] } = options
  // Looked up once per request instead of once per target, which matters on a
  // page with 250 candidates.
  const elements = new Map(table.elements.map((element) => [element.index, element]))
  const questions: Record<string, ChoiceQuestion> = {
    operation: {
      type: 'choice',
      criteria: operationCriteria(table),
      instructions: { goal, rules: NEXT_ACTION },
    },
  }
  for (const operation of OPERATIONS) {
    if (hasTargets(table, operation)) {
      questions[`${operation.toLowerCase()}_target`] = targetCriteria(operation, table, goal, elements)
    }
  }
  return {
    model: options.model ?? DEFAULT_MODEL,
    state: {
      page: {
        url: snap.url,
        title: snap.title,
        text: snap.text,
        viewport: { w: snap.w, h: snap.h },
        scroll: { y: snap.scroll.y, height: snap.scroll.height },
      },
      elements: table.elements,
      recent_actions: history.slice(-10),
    },
    questions,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

/** Rejects an answer unless it names an offered choice, covers exactly those choices, and wins. */
export function validateAnswer(answer: unknown, ids: string[]): ChoiceAnswer {
  const invalid = () =>
    fail('INVALID_DECISION', `Model answered outside the offered choices: ${JSON.stringify(answer)}`)
  if (!isRecord(answer)) return invalid()
  const { choice, confidence, probabilities } = answer
  if (typeof choice !== 'string' || !ids.includes(choice)) return invalid()
  if (!isRecord(probabilities)) return invalid()
  const keys = Object.keys(probabilities)
  if (keys.length !== ids.length || keys.some((key) => !ids.includes(key))) return invalid()
  const values: Record<string, number> = {}
  for (const key of keys) {
    const value = probabilities[key]
    if (!isProbability(value)) return invalid()
    values[key] = value
  }
  const numbers = Object.values(values)
  const sum = numbers.reduce((total, value) => total + value, 0)
  if (Math.abs(sum - 1) > 0.02) return invalid()
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return invalid()
  const best = Math.max(...numbers)
  if (values[choice] < best - 1e-6) return invalid()
  return { choice, confidence, probabilities: values }
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && 0 <= value && value <= 1
}

function offeredOperations(table: ActionTable): string[] {
  const offered: string[] = []
  for (const operation of OPERATIONS) {
    if (hasTargets(table, operation)) offered.push(operation)
  }
  return [...offered, ...Object.keys(table.controls), 'DONE', 'BLOCKED']
}

/** Maps a response back to the single action the executor is allowed to run. */
export function readDecision(response: unknown, table: ActionTable): Decision {
  const answers = isRecord(response) ? response.answers : undefined
  if (!isRecord(answers)) fail('INVALID_DECISION', 'Response has no answers object')
  const operation = validateAnswer(answers.operation, offeredOperations(table))
  if (operation.choice === 'DONE' || operation.choice === 'BLOCKED') {
    return {
      kind: operation.choice === 'DONE' ? 'done' : 'blocked',
      operation: operation.choice,
      confidence: operation.confidence,
      probabilities: operation.probabilities,
    }
  }
  const control = table.controls[operation.choice]
  if (control) {
    return {
      kind: 'action',
      operation: control.key,
      confidence: operation.confidence,
      probabilities: operation.probabilities,
      control,
    }
  }
  const candidates = table.targets[operation.choice as Operation]
  const target = validateAnswer(answers[`${operation.choice.toLowerCase()}_target`], Object.keys(candidates))
  return {
    kind: 'action',
    operation: operation.choice,
    confidence: operation.confidence,
    probabilities: target.probabilities,
    action: candidates[target.choice],
  }
}

export function endpointOf(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

export async function postJson(url: string, apiKey: string, body: unknown, timeout = 25_000): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    })
  } catch (error) {
    fail('MODEL_ERROR', `Cannot reach ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const text = await response.text()
  const payload = parseJson(text)
  if (!response.ok) {
    const error = isRecord(payload) ? payload.error : null
    const code = isRecord(error) ? error.code : undefined
    const message = isRecord(error) ? error.message : undefined
    fail('MODEL_ERROR', `${code ?? `HTTP ${response.status}`}: ${message ?? text.slice(0, 200)}`)
  }
  if (payload === null) fail('MODEL_ERROR', `Model returned a non-JSON body: ${text.slice(0, 200)}`)
  return payload
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

/** Reads the content of the first choice out of a chat completion. */
function messageContent(payload: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return null
  const [choice] = payload.choices
  if (!isRecord(choice) || !isRecord(choice.message)) return null
  return choice.message.content
}

/** Reads `{"text": "..."}` out of a chat completion, or null when the model declined. */
export function readTextAnswer(payload: unknown): string | null {
  const content = messageContent(payload)
  if (typeof content !== 'string') fail('MODEL_ERROR', 'Text model did not return {"text": "..."}')
  const parsed = parseJson(content)
  if (!isRecord(parsed) || Object.keys(parsed).length !== 1)
    fail('MODEL_ERROR', 'Text model did not return {"text": "..."}')
  if (parsed.text === null) return null
  if (typeof parsed.text !== 'string' || !parsed.text.trim())
    fail('MODEL_ERROR', 'Text model did not return {"text": "..."}')
  return parsed.text
}
