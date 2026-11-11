import type { Snapshot, SnapshotAction, SnapshotElement } from './snapshot.ts'

export type Operation = 'CLICK' | 'TYPE_TEXT' | 'SELECT' | 'UPLOAD'

export interface ElementEntry {
  index: string
  label: string
  context?: string
  role: string
  operations: string[]
  value: string
  current_value?: string
  checked?: string
  selected?: string
  expanded?: string
}

interface ScrollControl {
  key: string
  kind: 'scroll'
  label: string
  delta: number
}

interface WaitControl {
  key: string
  kind: 'wait'
  label: string
}

interface SwitchControl {
  key: string
  kind: 'switch'
  label: string
  tabId: string
}

interface BackControl {
  key: string
  kind: 'back'
  label: string
}

/** Everything the decision model may run that is not an element action. */
export type ControlAction = ScrollControl | WaitControl | SwitchControl | BackControl

/** A page target other than the attached one, offered as a switch choice. */
export interface TabChoice {
  id: string
  title: string
  url: string
}

export interface CollectOptions {
  tabs?: TabChoice[]
  current?: string
}

export interface Targets {
  CLICK: Record<string, SnapshotAction>
  TYPE_TEXT: Record<string, SnapshotAction>
  SELECT: Record<string, SnapshotAction>
  UPLOAD: Record<string, SnapshotAction>
}

export interface ActionTable {
  elements: ElementEntry[]
  targets: Targets
  controls: Record<string, ControlAction>
}

const OPERATION: Record<SnapshotAction['kind'], Operation> = {
  click: 'CLICK',
  fill: 'TYPE_TEXT',
  select: 'SELECT',
  upload: 'UPLOAD',
}

function groupByRef(actions: SnapshotAction[]): Map<string, SnapshotAction[]> {
  const grouped = new Map<string, SnapshotAction[]>()
  for (const action of actions) {
    const list = grouped.get(action.ref)
    if (list) {
      list.push(action)
      continue
    }
    grouped.set(action.ref, [action])
  }
  return grouped
}

function entryOf(element: SnapshotElement): ElementEntry {
  return {
    index: element.ref,
    label: element.label,
    context: element.context,
    role: element.role,
    operations: element.operations.slice(),
    value: element.value ?? '',
    checked: element.checked,
    selected: element.selected,
    expanded: element.expanded,
  }
}

function tabControls(options: CollectOptions): Record<string, ControlAction> {
  const controls: Record<string, ControlAction> = {}
  let index = 0
  for (const tab of options.tabs ?? []) {
    if (tab.id === options.current) continue
    index++
    const key = `SWITCH_${index}`
    const title = tab.title || tab.url
    controls[key] = { key, kind: 'switch', label: `Switch to tab: ${title} (${tab.url})`, tabId: tab.id }
  }
  return controls
}

function scrollControls(snap: Snapshot): Record<string, ControlAction> {
  const controls: Record<string, ControlAction> = {
    WAIT: { key: 'WAIT', kind: 'wait', label: 'Wait for the page to update' },
  }
  if (snap.scroll.y > 0) {
    controls.SCROLL_UP = {
      key: 'SCROLL_UP',
      kind: 'scroll',
      label: 'Scroll up one screen',
      delta: -Math.round(snap.h * 0.8),
    }
  }
  if (snap.scroll.y + snap.h < snap.scroll.height - 2) {
    controls.SCROLL_DOWN = {
      key: 'SCROLL_DOWN',
      kind: 'scroll',
      label: 'Scroll down one screen',
      delta: Math.round(snap.h * 0.8),
    }
  }
  if (snap.history > 1) {
    controls.BACK = { key: 'BACK', kind: 'back', label: 'Go back to the previous page' }
  }
  return controls
}

/**
 * Turns a snapshot into the closed set of choices a decision model may pick from.
 * Pure and deterministic: the same snapshot always produces the same table.
 */
export function collectActions(snap: Snapshot, options: CollectOptions = {}): ActionTable {
  const targets: Targets = { CLICK: {}, TYPE_TEXT: {}, SELECT: {}, UPLOAD: {} }
  const grouped = groupByRef(snap.actions)
  const optionCounts: Map<string, number> = new Map()
  const elements: ElementEntry[] = []

  for (const element of snap.elements) {
    const actions = grouped.get(element.ref)
    if (!actions) continue
    const entry = entryOf(element)
    for (const action of actions) {
      if (action.kind !== 'select') {
        targets[OPERATION[action.kind]][element.ref] = action
        continue
      }
      const count = (optionCounts.get(element.ref) ?? 0) + 1
      optionCounts.set(element.ref, count)
      targets.SELECT[`${element.ref}:${count}`] = action
      entry.current_value = action.current_value
    }
    elements.push(entry)
  }

  return { elements, targets, controls: { ...scrollControls(snap), ...tabControls(options) } }
}
