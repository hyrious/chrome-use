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
  writeState,
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

// Scroll position, occlusion, hover menus, and fields that refuse what they are given.
const edge = `<!doctype html><html><head><title>edge</title><style>
  body { margin: 0; font: 16px sans-serif; height: 3000px }
  #visible { margin-top: 100px }
  #covered { position: absolute; left: 0; width: 200px; height: 30px }
  #hover { display: inline-block; margin-top: 40px }
  #menu { display: none }
  #hoverwrap:hover #menu { display: block }
  .card { cursor: pointer; width: 240px; padding: 6px; border: 1px solid #ccc; margin: 6px }
  footer { position: fixed; bottom: 0; left: 0; right: 0; height: 140px; background: #fff; border-top: 1px solid #ccc }
</style></head><body>
<button id="visible">Visible button</button>
<button id="covered">Covered button</button>
<span id="hoverwrap"><span id="hover">Hover me</span>
<div id="menu" role="menu"><button role="menuitem" onclick="window.menu = 1">Menu item</button></div></span>
<div class="card" id="card" onclick="window.cardClicks = (window.cardClicks || 0) + 1">Design hotel with free cancellation</div>
<div class="card" id="wrapper"><span>Wrapper card</span><button onclick="window.innerClicks = 1">Inner action</button></div>
<canvas id="board" width="160" height="60" style="display:block;margin:8px 0;border:1px solid #333" onclick="window.boardClicks = (window.boardClicks || 0) + 1"></canvas>
<form onsubmit="event.preventDefault()">
<label for="revert">Revert field</label><input id="revert">
<label for="scratch">Scratch field</label><input id="scratch">
<input type="file" id="guard" aria-label="Guarded upload" onchange="this.value = ''">
<label for="ro">Read only field</label><input id="ro" readonly value="fixed">
<label for="short">Short field</label><input id="short" maxlength="3">
<label for="pick">Pick</label><select id="pick"><option value="a">A</option><option value="b">B</option></select>
</form>
<footer onclick="window.wrongClicks = (window.wrongClicks || 0) + 1">sticky footer</footer>
<input type="file" id="hidden-upload" style="display:none" aria-label="Hidden attachment">
<button id="noop">Does nothing</button>
<button id="loading">Loads over the network</button>
<p id="fetched"></p>
<script>
  window.clicks = 0
  document.getElementById('visible').onclick = () => window.clicks++
  const covered = document.getElementById('covered')
  covered.style.top = (innerHeight - 30) + 'px'
  covered.onclick = () => window.clicks++
  const revert = document.getElementById('revert')
  revert.addEventListener('input', () => { revert.value = 'managed' })
  const pick = document.getElementById('pick')
  pick.addEventListener('change', () => { pick.value = 'a' })
  // The response arrives 400ms after the click and changes no DOM until then:
  // only the in-flight request says the click is still doing something.
  document.getElementById('loading').onclick = async () => {
    const body = await (await fetch('/slow')).text()
    document.getElementById('fetched').textContent = body
  }
</script>
</body></html>`

const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' })
  if (request.url === '/detail') response.end('<!doctype html><title>detail</title><h1>Detail page</h1>')
  else if (request.url === '/slow') setTimeout(() => response.end('slow result'), 400)
  else if (request.url === '/inner') response.end(inner)
  else if (request.url === '/edge') response.end(edge)
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
  // A state file that names a tab keeps it: dropping it would send the next
  // command to whichever tab Chrome happens to list first.
  writeState({ ...readState()!, tab: 'remembered-tab-id' })
  await start({ port, profile: join(home, 'profile') })
  check('reuse keeps the remembered tab', readState()?.tab === 'remembered-tab-id', JSON.stringify(readState()))

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
    check('dialog counted', snap.dialogs >= 1, String(snap.dialogs))
    check('dialog keeps what it said', snap.dialog === 'alert "hi there"', String(snap.dialog))

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

    // acting on a visible element leaves the scroll position alone, and an
    // element under a sticky footer still gets centered and pressed
    await bu.open(`${url}edge`)
    const visible = findByLabel(await bu.snap(), 'visible button')
    await bu.click(visible.ref)
    check('a visible click does not scroll', (await bu.eval<number>('scrollY')) === 0, String(await bu.eval('scrollY')))
    check(
      'a visible click lands',
      (await bu.eval<number>('window.clicks')) === 1,
      String(await bu.eval('window.clicks')),
    )
    const covered = findByLabel(await bu.snap(), 'covered button')
    await bu.click(covered.ref)
    check(
      'a covered click lands',
      (await bu.eval<number>('window.clicks')) === 2,
      String(await bu.eval('window.clicks')),
    )
    check('a covered click never presses the footer', (await bu.eval('window.wrongClicks ?? 0')) === 0)

    // hover opens a menu the snapshot can then act on
    await bu.hover('#hover')
    const opened = await bu.snap()
    const item = opened.elements.find((element) => element.label === 'Menu item')
    check('hover reveals a menu', !!item, JSON.stringify(opened.elements.map((element) => element.label)))
    if (item) {
      await bu.click(item.ref)
      check('a hovered menu clicks', (await bu.eval('window.menu')) === 1)
    }

    // a region the page only marked with a pointer cursor is an element too
    let snap2 = await bu.snap()
    const card = findByLabel(snap2, 'design hotel')
    check('a pointer region is listed', card.role === 'clickable', card.role)
    await bu.click(card.ref)
    check(
      'a pointer region clicks',
      (await bu.eval('window.cardClicks')) === 1,
      String(await bu.eval('window.cardClicks')),
    )
    snap2 = await bu.snap()
    const listed = snap2.elements.map((element) => element.label)
    check('a region holding a control is left out', !listed.includes('Wrapper card'), JSON.stringify(listed))
    check('the control inside it is listed', listed.includes('Inner action'), JSON.stringify(listed))

    // an action reports what it did instead of leaving it to a diff of two snapshots
    const noop = findByLabel(await bu.snap(), 'does nothing')
    const quiet = await bu.click(noop.ref)
    check('a click that changes nothing says so', quiet.outcome?.kind === 'none', JSON.stringify(quiet.outcome))

    // a response that lands 400ms after the click is still part of the click
    const fetching = await bu.click(findByLabel(await bu.snap(), 'loads over the network').ref)
    const fetched = await bu.eval<string>('document.getElementById("fetched").textContent')
    check('settle waits for the request the click started', fetched === 'slow result', fetched)
    check(
      'the late update is reported as a change',
      fetching.outcome?.kind === 'changed',
      JSON.stringify(fetching.outcome),
    )

    // an upload box that hides its input still offers the upload
    const hidden = (await bu.snap()).elements.find((element) => element.label === 'Hidden attachment')
    check('a hidden file input is listed', hidden?.hidden === true && hidden.role === 'file', JSON.stringify(hidden))
    if (hidden) {
      await bu.upload(hidden.ref, [join(home, 'note.txt')])
      check(
        'a hidden file input takes the file',
        (await bu.eval('document.getElementById("hidden-upload").files[0]?.name')) === 'note.txt',
      )
    }

    // a canvas has no role, so only a screenshot and a point can reach it
    await bu.eval('document.getElementById("board").scrollIntoView({ block: "center", behavior: "instant" })')
    const box = await bu.eval<{ x: number; y: number; width: number; height: number }>(
      'JSON.parse(JSON.stringify(document.getElementById("board").getBoundingClientRect()))',
    )
    const pointX = Math.round(box.x + box.width / 2)
    const pointY = Math.round(box.y + box.height / 2)
    const look = await bu.point(pointX, pointY, { dryRun: true })
    check('a point describes its target', look.hit === 'canvas', String(look.hit))
    check('a dry run presses nothing', (await bu.eval('window.boardClicks ?? 0')) === 0)
    await bu.point(pointX, pointY)
    check('a point clicks', (await bu.eval('window.boardClicks')) === 1, String(await bu.eval('window.boardClicks')))
    let outside: unknown
    try {
      await bu.point(-5, 5)
    } catch (error) {
      outside = error
    }
    check(
      'a point outside the viewport is rejected',
      outside instanceof ChromeUseError && outside.code === 'NOT_INTERACTABLE',
      String(outside),
    )

    // fields that silently drop or revert the text are failures, not successes
    let reverted: unknown
    try {
      await bu.type(findByLabel(await bu.snap(), 'revert field').ref, 'typed')
    } catch (error) {
      reverted = error
    }
    check(
      'a reverted value is reported',
      reverted instanceof ChromeUseError && reverted.code === 'INPUT_MISMATCH',
      String(reverted),
    )

    let readonly: unknown
    try {
      await bu.type(findByLabel(await bu.snap(), 'read only field').ref, 'x')
    } catch (error) {
      readonly = error
    }
    check(
      'a read only field is rejected',
      readonly instanceof ChromeUseError && readonly.code === 'NOT_INTERACTABLE',
      String(readonly),
    )

    let tooLong: unknown
    try {
      await bu.type(findByLabel(await bu.snap(), 'short field').ref, 'abcd')
    } catch (error) {
      tooLong = error
    }
    check(
      'a value over maxlength is rejected',
      tooLong instanceof ChromeUseError && tooLong.code === 'NOT_INTERACTABLE',
      String(tooLong),
    )

    let kept: unknown
    try {
      await bu.select(findByLabel(await bu.snap(), 'pick').ref, 'b')
    } catch (error) {
      kept = error
    }
    check(
      'a select the page reverts is reported',
      kept instanceof ChromeUseError && kept.code === 'INPUT_MISMATCH',
      String(kept),
    )

    // an empty text clears the field, and an upload the page drops is a failure
    const scratch = findByLabel(await bu.snap(), 'scratch field')
    await bu.type(scratch.ref, 'abc')
    const filled = await bu.eval<string>('document.getElementById("scratch").value')
    check('type fills the field', filled === 'abc', filled)
    await bu.type(scratch.ref, '')
    const cleared = await bu.eval<string>('document.getElementById("scratch").value')
    check('an empty type clears the field', cleared === '', cleared)

    let dropped: unknown
    try {
      await bu.upload(findByLabel(await bu.snap(), 'guarded upload').ref, [join(home, 'note.txt')])
    } catch (error) {
      dropped = error
    }
    check(
      'a dropped upload is reported',
      dropped instanceof ChromeUseError && dropped.code === 'INPUT_MISMATCH',
      String(dropped),
    )

    // waits poll instead of sleeping
    await bu.waitForText('sticky footer')
    await bu.waitForURL(/\/edge$/)
    await bu.waitFor('document.body !== null')
    let timedOut: unknown
    try {
      await bu.waitFor('false', { maxTime: 0.3 })
    } catch (error) {
      timedOut = error
    }
    check('waitFor times out', timedOut instanceof ChromeUseError && timedOut.code === 'TIMEOUT', String(timedOut))

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
  // Chrome releases its profile a moment after it exits, so a single unlink can
  // still hit a locked file on Windows. The run's result is what matters here.
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exitCode = failed ? 1 : 0
