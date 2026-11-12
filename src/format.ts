import type { SnapshotResult } from './snapshot.ts'

/** How much of a long element table survives truncation: the head, then the tail. */
const HEAD_SHARE = 0.8
const TAIL_SHARE = 0.2

/** Characters of element table a terminal print keeps before it starts cutting. */
const PRINT_BUDGET = 8000

function fit(lines: string[], budget: number): number {
  let size = 0
  for (const [index, line] of lines.entries()) {
    size += line.length + 1
    if (size > budget) return index
  }
  return lines.length
}

/**
 * Keeps an element table within `budget` characters. The end of a page usually
 * holds what finishes a step, a dialog's checkbox and its Submit, so the tail
 * is kept instead of cutting everything after the first line that does not fit.
 */
export function truncateElements(lines: string[], budget: number): string[] {
  if (fit(lines, budget) >= lines.length) return lines
  const head = fit(lines, budget * HEAD_SHARE)
  const tail = fit(lines.toReversed(), budget * TAIL_SHARE)
  const cut = lines.length - head - tail
  return [
    ...lines.slice(0, head),
    `... ${cut} element(s) cut here; narrow the page, or raise --limit`,
    ...lines.slice(head + cut),
  ]
}

/** What an action did, in the words a caller can act on without reading the page again. */
function describeOutcome(outcome: NonNullable<SnapshotResult['outcome']>): string {
  if (outcome.kind === 'navigated') {
    return `navigated to ${outcome.url}${outcome.error ? ` (${outcome.error})` : ''}`
  }
  return outcome.kind === 'changed' ? 'page changed' : 'no change'
}

/** Prints the outcome, then the page text and the element table a reader acts on. */
export function printSnapshot(snap: SnapshotResult, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(snap, null, 2))
    return
  }
  if (snap.outcome) console.log(`${describeOutcome(snap.outcome)}\n`)
  console.log(`${snap.title}\n${snap.url}\n`)
  if (snap.text) console.log(`${snap.text}\n`)
  const width = Math.max(3, ...snap.elements.map((element) => element.ref.length))
  const lines = snap.elements.map((element) => {
    const operations = element.operations.join(',')
    const value = element.value ? `  value=${JSON.stringify(element.value)}` : ''
    const states = [element.checked, element.selected, element.expanded]
      .map((state, i) => (state && state !== 'false' ? `  ${['checked', 'selected', 'expanded'][i]}=${state}` : ''))
      .join('')
    const hidden = element.hidden ? '  hidden' : ''
    const label = JSON.stringify(element.label)
    return `${element.ref.padEnd(width)}  ${element.role.padEnd(11)}  ${label}  ${operations}${value}${states}${hidden}`
  })
  for (const line of truncateElements(lines, PRINT_BUDGET)) console.log(line)
  if (snap.hiddenFrames)
    console.log(`\n${snap.hiddenFrames} frame(s) from another origin not readable; the loop cannot act inside them`)
  if (snap.truncated) console.log(`\n${snap.truncated} more element(s) not listed; scroll or narrow the page`)
  if (snap.dialogs)
    console.log(`\naccepted ${snap.dialogs} dialog(s)${snap.dialog ? `, the last one: ${snap.dialog}` : ''}`)
}
