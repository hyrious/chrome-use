// Manual smoke run: real Chrome, real CDP, local fixture. Not a test suite.
//   node scripts/smoke.ts

import type { AddressInfo } from 'node:net'
import type { Snapshot, SnapshotElement } from '../src/index.ts'

import { mkdtempSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildRequest,
  ChromeUseError,
  collectActions,
  readState,
  run,
  runScript,
  Session,
  start,
  stop,
} from '../src/index.ts'

const home = mkdtempSync(join(tmpdir(), 'chrome-use-smoke-'))
process.env.CHROME_USE_HOME = home
const port = 9399

const rawPage = `<!doctype html><html><head><title>fixture</title></head><body style="font:16px sans-serif">
<h1>Hotel search</h1>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent='enter:'+document.getElementById('where').value">
<label for="where">Where to?</label>
<input id="where" placeholder="City">
</form>
<label for="stay">Stay category</label>
<select id="stay"><option value="">Any</option><option value="design">Design</option><option value="budget">Budget</option></select>
<label><input type="checkbox" id="free"> Free cancellation</label>
<button id="go" onclick="document.getElementById('out').textContent='searched:'+document.getElementById('where').value+':'+document.getElementById('stay').value">Search</button>
<button id="pop" onclick="alert('hi there')">Popup</button>
<a id="blank" href="/detail" target="_blank">Open detail</a>
<input type="file" id="attach" aria-label="Attachment">
<deep-card></deep-card>
<iframe id="frame" src="/inner" width="320" height="120"></iframe>
<iframe id="other" src="http://localhost:PORT/inner" width="320" height="120"></iframe>
<p id="deep-out"></p>
<script>
  customElements.define('deep-card', class extends HTMLElement {
    constructor() {
      super()
      this.attachShadow({ mode: 'open' }).innerHTML = '<button id="shadow" onclick="this.getRootNode().host.dataset.clicked = 1">Shadow button</button><input aria-label="Shadow field">'
    }
  })
</script>
<p id="out"></p>
</body></html>`

const inner = `<!doctype html><title>inner</title>
<button onclick="parent.document.getElementById('deep-out').textContent='inner'">Inner button</button>`

const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' })
  if (request.url === '/detail') response.end('<!doctype html><title>detail</title><h1>Detail page</h1>')
  else if (request.url === '/inner') response.end(inner)
  else response.end(page)
})
await new Promise<void>((done) => server.listen(0, () => done()))
const httpPort = (server.address() as AddressInfo).port
const url = `http://127.0.0.1:${httpPort}/`
const page = rawPage.replaceAll('PORT', String(httpPort))

let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failed++
  console.log(`  FAIL ${name} ${detail}`)
}

function findByLabel(snap: Snapshot, text: string): SnapshotElement {
  const lower = text.toLowerCase()
  const found = snap.elements.find((element) => element.label.toLowerCase().includes(lower))
  if (!found) throw new Error(`the fixture lost its "${text}" element`)
  return found
}

try {
  const started = await start({ port, profile: join(home, 'profile'), url })
  console.log(`started on ${started.port}, ${started.reused ? 'reused' : 'new'}`)

  // Reusing a live Chrome with a missing state file must write it back.
  rmSync(join(home, 'state.json'), { force: true })
  const reused = await start({ port, profile: join(home, 'profile') })
  check('reuse rewrites state', reused.reused && readState()?.port === port, JSON.stringify(readState()))

  const bu = await Session.connect({ port })
  try {
    check('background page has emulated focus', await bu.eval<boolean>('document.hasFocus()'))
    const window = await bu.send<{ bounds: { width: number; height: number } }>('Browser.getWindowForTarget', {
      targetId: bu.targetId,
    })
    check(
      'startup preserves window size',
      window.bounds.width === 1280 && window.bounds.height === 880,
      JSON.stringify(window.bounds),
    )
    let snap = await bu.snap()
    check('snapshot has url', snap.url === url, snap.url)
    check('snapshot has text', snap.text.includes('Hotel search'), snap.text.slice(0, 40))
    check(
      'snapshot has searchbox',
      snap.elements.some((element) => element.role === 'textbox'),
    )
    check(
      'snapshot has select',
      snap.elements.some((element) => element.role === 'combobox'),
    )

    const where = findByLabel(snap, 'where to')
    snap = await bu.type(where.ref, 'Lisbon')
    const typed = snap.elements.find((element) => element.ref === where.ref)
    check('type sets value', typed?.value === 'Lisbon', typed?.value)

    const stay = snap.elements.find((element) => element.role === 'combobox')
    if (!stay) throw new Error('the fixture lost its select')
    snap = await bu.select(stay.ref, 'design')
    const selectAction = snap.actions.find((action) => action.kind === 'select')
    check(
      'select updates options',
      !!selectAction && selectAction.current_value === 'Design',
      JSON.stringify(selectAction?.current_value),
    )

    const search = findByLabel(snap, 'search')
    snap = await bu.click(search.ref)
    check('click runs the handler', snap.text.includes('searched:Lisbon:design'), snap.text.slice(0, 80))

    snap = await bu.type(where.ref, 'Porto')
    await bu.press('Enter')
    snap = await bu.snap()
    check('enter submits the form', snap.text.includes('enter:Porto'), snap.text.slice(0, 80))

    const popup = findByLabel(snap, 'popup')
    snap = await bu.click(popup.ref)
    check('dialog dismissed and counted', snap.dialogs >= 1, String(snap.dialogs))

    // a target=_blank link opens a tab; the library never follows it on its own
    const original = bu.targetId
    const blank = findByLabel(await bu.snap(), 'open detail')
    await bu.click(blank.ref)
    let tabs = await bu.tabs()
    for (let attempt = 0; attempt < 10 && !tabs.some((tab) => tab.url.endsWith('/detail')); attempt++) {
      await new Promise((done) => setTimeout(done, 100))
      tabs = await bu.tabs()
    }
    const detail = tabs.find((tab) => tab.url.endsWith('/detail'))
    check('target=_blank opens a tab', !!detail, JSON.stringify(tabs.map((tab) => tab.url)))
    if (detail) {
      await bu.use(detail.id)
      check('use switches tab', (await bu.snap()).url.endsWith('/detail'))
    }
    const switched = collectActions(await bu.snap(), { tabs: await bu.tabs(), current: bu.targetId })
    check(
      'table offers switch controls',
      Object.values(switched.controls).some((control) => control.kind === 'switch'),
    )
    await bu.use(original)
    if (detail) {
      await bu.closeTab(detail.id)
      check('closeTab closes a tab', !(await bu.tabs()).some((tab) => tab.id === detail.id))
    }

    // file inputs are reachable and can be attached to
    await writeFile(join(home, 'note.txt'), 'hello')
    const attach = findByLabel(await bu.snap(), 'attachment')
    check('snapshot lists file inputs', attach?.role === 'file', JSON.stringify(attach))
    if (attach) {
      await bu.upload(attach.ref, [join(home, 'note.txt')])
      check(
        'upload attaches a file',
        (await bu.eval('document.getElementById("attach").files[0]?.name')) === 'note.txt',
      )
    }

    // open shadow roots and same origin frames are part of the page
    const deep = await bu.snap()
    const shadow = deep.elements.find((element) => element.label === 'Shadow button')
    const framed = deep.elements.find((element) => element.label === 'Inner button')
    check('snapshot reaches shadow roots', !!shadow, JSON.stringify(deep.elements.map((element) => element.label)))
    check('snapshot reaches same origin frames', !!framed, '')
    check('snapshot counts unreadable frames', deep.hiddenFrames === 1, String(deep.hiddenFrames))
    if (shadow) {
      await bu.click(shadow.ref)
      check('shadow button clicks', (await bu.eval('document.querySelector("deep-card").dataset.clicked')) === '1')
    }
    if (framed) {
      await bu.click(framed.ref)
      check('framed button clicks', (await bu.eval('document.getElementById("deep-out").textContent')) === 'inner')
    }

    // opening the same url twice must not keep the old scroll position
    await bu.eval('document.body.style.minHeight = "4000px"; window.scrollTo(0, 1200)')
    await bu.open(url)
    check('open resets the scroll position', (await bu.eval<number>('scrollY')) === 0, String(await bu.eval('scrollY')))

    // history back, once the tab has somewhere to go
    await bu.open(`${url}detail`)
    const back = collectActions(await bu.snap())
    const backControl = Object.values(back.controls).find((control) => control.kind === 'back')
    check('table offers back after a navigation', !!backControl, JSON.stringify(Object.keys(back.controls)))
    await bu.open(url)

    // table + request generation
    const table = collectActions(snap)
    check('table has click targets', Object.keys(table.targets.CLICK).length > 0)
    check('table has fill targets', Object.keys(table.targets.TYPE_TEXT).length > 0)
    check('table has wait control', !!table.controls.WAIT)
    const request = buildRequest({ goal: 'Search Lisbon design hotels', snap, table })
    check('request model default', request.model === 'typesafe/jev')
    check('request has operation question', !!request.questions.operation)
    check('request has target heads', !!request.questions.click_target && !!request.questions.type_text_target)
    const operation = request.questions.operation
    check('operation offers DONE and BLOCKED', 'DONE' in operation.criteria && 'BLOCKED' in operation.criteria)
    const criteria = request.questions.type_text_target.criteria
    check(
      'fill criteria keyed by ref',
      Object.keys(criteria).every((key) => /^e\d+-[a-z0-9]+$/.test(key)),
    )
    check(
      'fill criteria shows current value',
      Object.values(criteria).some((entry) => (entry as Record<string, unknown>).current_value === 'Porto'),
    )
    check('page text capped', request.state.page.text.length <= 6000)

    const dry = await run(bu, {
      goal: 'Search Lisbon',
      maxSteps: 1,
      jev: { baseUrl: '', apiKey: '', model: 'typesafe/jev' },
      dryRun: true,
    })
    check('run dry-run returns request', dry.status === 'dry-run' && !!dry.request, dry.status)

    // stale ref after a navigation
    const ref = where.ref
    await bu.open(url)
    let stale: unknown
    try {
      await bu.click(ref)
    } catch (error) {
      stale = error
    }
    check('stale ref rejected', stale instanceof ChromeUseError && stale.code === 'STALE', String(stale))

    // Scripts get cu, and can await it.
    check('runScript binds cu', (await runScript(bu, 'const { url } = await cu.snap(); return url')) === url)
    check('runScript aliases bu to cu', (await runScript(bu, 'return bu === cu')) === true)

    // raw cdp escape hatch
    const title = await bu.eval('document.title')
    check('eval works', title === 'fixture', String(title))

    const ids = await bu.send<{ targetInfos: unknown[] }>('Target.getTargets')
    check('raw cdp works', Array.isArray(ids.targetInfos))
  } finally {
    bu.close()
  }
} finally {
  await stop()
  server.close()
  rmSync(home, { recursive: true, force: true })
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exitCode = failed ? 1 : 0
