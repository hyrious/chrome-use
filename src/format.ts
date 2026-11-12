import type { Snapshot } from './snapshot.ts'

/** Prints the page text and the element table, the two things a reader acts on. */
export function printSnapshot(snap: Snapshot, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(snap, null, 2))
    return
  }
  console.log(`${snap.title}\n${snap.url}\n`)
  if (snap.text) console.log(`${snap.text}\n`)
  const width = Math.max(3, ...snap.elements.map((element) => element.ref.length))
  for (const element of snap.elements) {
    const operations = element.operations.join(',')
    const value = element.value ? `  value=${JSON.stringify(element.value)}` : ''
    const states = [element.checked, element.selected, element.expanded]
      .map((state, i) => (state && state !== 'false' ? `  ${['checked', 'selected', 'expanded'][i]}=${state}` : ''))
      .join('')
    console.log(
      `${element.ref.padEnd(width)}  ${element.role.padEnd(11)}  ${JSON.stringify(element.label)}  ${operations}${value}${states}`,
    )
  }
  if (snap.hiddenFrames)
    console.log(`\n${snap.hiddenFrames} frame(s) from another origin not readable; the loop cannot act inside them`)
  if (snap.truncated) console.log(`\n${snap.truncated} more element(s) not listed; scroll or narrow the page`)
  if (snap.dialogs)
    console.log(`\naccepted ${snap.dialogs} dialog(s)${snap.dialog ? `, the last one: ${snap.dialog}` : ''}`)
}
