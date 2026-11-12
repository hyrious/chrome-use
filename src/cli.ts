#!/usr/bin/env node
import type { Args } from './args.ts'
import type { ModelConfig } from './decide.ts'
import type { Snapshot } from './snapshot.ts'

import { readFileSync } from 'node:fs'
import { setGlobalProxyFromEnv } from 'node:http'
import { fileURLToPath } from 'node:url'

import { collectActions } from './actions.ts'
import { run } from './agent.ts'
import { booleanFlag, fillsOf, flag, numberFlag, parseArgs, portOf, uploadsOf } from './args.ts'
import { listTargets } from './cdp.ts'
import { start, status, stop } from './chrome.ts'
import { buildRequest, DEFAULT_MODEL, endpointOf, postJson, readDecision } from './decide.ts'
import { ChromeUseError, fail, messageOf } from './errors.ts'
import { printSnapshot } from './format.ts'
import { runScript } from './script.ts'
import { Session } from './session.ts'

const USAGE = `chrome-use: drive the user's own headed Chrome over CDP.

  chrome-use start [url] [-p|--port 9333] [--profile dir] [--chrome path]
                        [-x|--proxy url] [--noproxy list] [--window-size 1280,880]
  chrome-use stop [-f|--force]
  chrome-use close [--tab id]
  chrome-use status [--json]
  chrome-use snap [--tab id] [--json] [--limit 250]
  chrome-use open <url> [--tab id] [--json]
  chrome-use click <ref|selector> [--json]
  chrome-use hover <ref|selector> [--json]        # for menus that open on hover
  chrome-use point <x> <y> [--dry-run] [--json]   # a viewport point, for a canvas or an unnamed control
  chrome-use type <ref|selector> <text> [--json]
  chrome-use select <ref|selector> <value> [--json]
  chrome-use upload <ref|selector> <file>...
  chrome-use press <key>              # Enter, Tab, or a chord like Control+a
  chrome-use eval '<js>'                 # expression in the page
  chrome-use js [code] [-f|--file path]  # script in node, with cu bound to the session
  chrome-use screenshot [file] [--full] [--json]
  chrome-use cdp <method> ['<json params>']
  chrome-use decide --goal <text> [--dry-run] [--json]
  chrome-use agent --goal <text> [--max-steps 20] [--fill 'Field=value']... [--upload 'Field=/path']...
                      [--jev-base-url url] [--jev-api-key key] [--jev-model typesafe/jev]
                      [--text-base-url url] [--text-api-key key] [--text-model name]
                      [--dry-run] [--json]
  chrome-use skill

Click, hover, type, select and upload take a ref from snap, or a CSS selector for
what snap leaves out: a file input a styled button opens, a div that only carries
a click handler, or a form control on a page too long to snapshot in one view.
type and select read the value back, so a field that reverts fails loudly.

Every command accepts --tab <id|prefix|index> and the model commands read
CHROME_USE_JEV_BASE_URL / CHROME_USE_JEV_API_KEY / CHROME_USE_JEV_MODEL and
CHROME_USE_TEXT_BASE_URL / CHROME_USE_TEXT_API_KEY / CHROME_USE_TEXT_MODEL
when the corresponding flags are absent. API keys prefer TYPESAFE_API_KEY and
OPENAI_API_KEY over CHROME_USE_*_API_KEY. Base URLs default to
https://api.typesafe.ai/v1 (Jev) and https://api.openai.com/v1 (text).`

type Command = (args: Args) => Promise<void>

function version(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return manifest.version
  } catch {
    return '0.0.0'
  }
}

async function withSession<T>(args: Args, action: (session: Session) => Promise<T>): Promise<T> {
  const session = await Session.connect({ tab: flag(args, '--tab'), port: portOf(args) })
  try {
    return await action(session)
  } finally {
    session.close()
  }
}

function modelOptions(args: Args, kind: 'jev' | 'text', required = true): ModelConfig {
  const prefix = `CHROME_USE_${kind.toUpperCase()}`
  const keyEnv = kind === 'jev' ? 'TYPESAFE_API_KEY' : 'OPENAI_API_KEY'
  const baseUrl =
    flag(args, `--${kind}-base-url`) ??
    process.env[`${prefix}_BASE_URL`] ??
    (kind === 'jev' ? 'https://api.typesafe.ai/v1' : 'https://api.openai.com/v1')
  const apiKey = flag(args, `--${kind}-api-key`) ?? (process.env[keyEnv] || process.env[`${prefix}_API_KEY`] || '')
  const model = flag(args, `--${kind}-model`) ?? process.env[`${prefix}_MODEL`] ?? (kind === 'jev' ? DEFAULT_MODEL : '')
  const enabled =
    kind === 'jev' ||
    ['base-url', 'api-key', 'model'].some((field) => args.flags.has(`--${kind}-${field}`)) ||
    ['BASE_URL', 'API_KEY', 'MODEL'].some((field) => process.env[`${prefix}_${field}`] !== undefined)
  if (required && enabled) {
    const missing = [
      !baseUrl && `--${kind}-base-url (${prefix}_BASE_URL)`,
      !apiKey && `--${kind}-api-key (${keyEnv} or ${prefix}_API_KEY)`,
      !model && `--${kind}-model (${prefix}_MODEL)`,
    ].filter(Boolean)
    if (missing.length) fail('MODEL_ERROR', `Missing model configuration: ${missing.join(', ')}`)
  }
  return { baseUrl, apiKey, model }
}

function positional(args: Args, index: number, message: string): string {
  const value = args.positionals[index]
  if (value === undefined) fail('NOT_INTERACTABLE', message)
  return value
}

function numberOf(args: Args, index: number, message: string): number {
  const value = Number(positional(args, index, message))
  if (!Number.isFinite(value)) fail('NOT_INTERACTABLE', `${message}; got ${JSON.stringify(args.positionals[index])}`)
  return value
}

function filesFrom(args: Args): string[] {
  const files = args.positionals.slice(1)
  if (!files.length) fail('NOT_INTERACTABLE', 'upload needs a ref and at least one file')
  return files
}

function refOf(args: Args): string {
  const ref = args.positionals[0]
  if (!ref) fail('NOT_INTERACTABLE', 'a ref such as e12-9fk is required')
  return ref
}

async function startCommand(args: Args): Promise<void> {
  const result = await start({
    url: args.positionals[0],
    port: portOf(args),
    profile: flag(args, '--profile'),
    chrome: flag(args, '--chrome'),
    proxy: flag(args, '--proxy', '-x'),
    noproxy: flag(args, '--noproxy'),
    windowSize: flag(args, '--window-size'),
  })
  if (booleanFlag(args, '--json')) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`${result.reused ? 'already running' : 'started'} on port ${result.port}`)
  console.log(`profile ${result.profile}`)
  console.log(result.wsUrl)
}

async function stopCommand(args: Args): Promise<void> {
  const result = await stop({ force: booleanFlag(args, '--force', '-f') })
  if (booleanFlag(args, '--json')) {
    console.log(JSON.stringify(result))
    return
  }
  console.log(result.stopped ? `stopped port ${result.port}` : 'not running')
}

async function closeCommand(args: Args): Promise<void> {
  const target = await withSession(args, async (session) => {
    const id = session.targetId
    await session.closeTab()
    return id
  })
  console.log(`closed ${target.slice(0, 8)}`)
}

async function statusCommand(args: Args): Promise<void> {
  const current = await status()
  const tabs = current.running ? await listTargets(current.port).catch(() => []) : []
  if (booleanFlag(args, '--json')) {
    const listed = tabs.map((tab) => ({ id: tab.id, url: tab.url, title: tab.title }))
    console.log(JSON.stringify({ ...current, tabs: listed }, null, 2))
    return
  }
  if (!current.running) {
    console.log('not running')
    return
  }
  console.log(`running on port ${current.port}, ${tabs.length} tab(s)`)
  console.log(`profile ${current.profile}`)
  console.log(current.wsUrl ?? '')
  for (const tab of tabs) console.log(`  ${tab.id.slice(0, 8)}  ${tab.url}`)
}

/** Commands that act and print the snapshot they return. */
const SNAPSHOT_ACTIONS: Record<string, (session: Session, args: Args) => Promise<Snapshot>> = {
  snap: (session, args) => session.snap({ limit: numberFlag(args, ['--limit'], 250) }),
  open: (session, args) => session.open(positional(args, 0, 'open needs a url')),
  click: (session, args) => session.click(refOf(args)),
  hover: (session, args) => session.hover(refOf(args)),
  type: (session, args) => session.type(refOf(args), positional(args, 1, 'type needs a ref and a text')),
  select: (session, args) => session.select(refOf(args), positional(args, 1, 'select needs a ref and a value')),
  upload: (session, args) => session.upload(refOf(args), filesFrom(args)),
}

function snapshotCommand(name: string): Command {
  const action = SNAPSHOT_ACTIONS[name]
  return async (args) => {
    const snap = await withSession(args, (session) => action(session, args))
    printSnapshot(snap, booleanFlag(args, '--json'))
  }
}

async function pressCommand(args: Args): Promise<void> {
  const key = args.positionals[0]
  if (!key) fail('NOT_INTERACTABLE', 'press needs a key')
  const snap = await withSession(args, (session) => session.press(key))
  printSnapshot(snap, booleanFlag(args, '--json'))
}

async function evalCommand(args: Args): Promise<void> {
  const expression = args.positionals[0]
  if (!expression) fail('NOT_INTERACTABLE', 'eval needs a JavaScript expression')
  await withSession(args, async (session) => {
    const value = await session.eval(expression)
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  })
}

async function jsCommand(args: Args): Promise<void> {
  const code = await scriptSource(args)
  const result = await withSession(args, (session) => runScript(session, code))
  if (result === undefined) return
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
}

async function scriptSource(args: Args): Promise<string> {
  const file = flag(args, '--file', '-f')
  if (file) return readFileSync(file, 'utf8')
  const inline = args.positionals[0]
  if (inline) return inline
  if (process.stdin.isTTY) fail('SCRIPT_ERROR', 'js needs code, --file <path>, or a script on stdin')
  return readFileSync(0, 'utf8')
}

async function screenshotCommand(args: Args): Promise<void> {
  const file = args.positionals[0] ?? 'chrome-use.png'
  const shot = await withSession(args, async (session) => {
    const buffer = await session.screenshot(file, { full: booleanFlag(args, '--full') })
    const size = pngSize(buffer)
    const viewport = await session.eval<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })')
    return {
      file,
      bytes: buffer.length,
      width: size?.width,
      height: size?.height,
      viewport: { width: viewport.w, height: viewport.h },
    }
  })
  if (booleanFlag(args, '--json')) {
    const scale = shot.width && shot.viewport.width ? shot.width / shot.viewport.width : 1
    console.log(JSON.stringify({ ...shot, scale }, null, 2))
    return
  }
  console.log(file)
}

/** A screenshot is in device pixels; a coordinate is in the CSS pixels of the page. */
function pngSize(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 24 || buffer.toString('latin1', 1, 4) !== 'PNG') return undefined
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

async function pointCommand(args: Args): Promise<void> {
  const x = numberOf(args, 0, 'point needs an x coordinate')
  const y = numberOf(args, 1, 'point needs a y coordinate')
  const dryRun = booleanFlag(args, '--dry-run')
  const snap = await withSession(args, (session) => session.point(x, y, { dryRun }))
  console.error(`${dryRun ? 'dry run, nothing pressed' : 'pressed'}; the point is over ${snap.hit}`)
  printSnapshot(snap, booleanFlag(args, '--json'))
}

async function cdpCommand(args: Args): Promise<void> {
  const method = args.positionals[0]
  if (!method) fail('NOT_INTERACTABLE', 'cdp needs a CDP method name')
  const params = args.positionals[1] ? JSON.parse(args.positionals[1]) : {}
  await withSession(args, async (session) => {
    console.log(JSON.stringify(await session.send(method, params), null, 2))
  })
}

async function decideCommand(args: Args): Promise<void> {
  const goal = flag(args, '--goal') ?? args.positionals[0]
  if (!goal) fail('NOT_INTERACTABLE', 'decide needs --goal')
  const dryRun = booleanFlag(args, '--dry-run')
  const config = modelOptions(args, 'jev', !dryRun)
  await withSession(args, async (session) => {
    const snap = await session.snap({ limit: numberFlag(args, ['--limit'], 250) })
    const table = collectActions(snap, { tabs: await session.tabs(), current: session.targetId })
    const request = buildRequest({ goal, snap, table, model: config.model })
    if (dryRun) {
      console.log(JSON.stringify(request, null, 2))
      return
    }
    const started = Date.now()
    const response = await postJson(endpointOf(config.baseUrl, '/systemone'), config.apiKey, request)
    const decision = readDecision(response, table)
    const output = {
      request,
      response,
      decision: {
        kind: decision.kind,
        operation: decision.operation,
        confidence: decision.confidence,
        action: decision.action ?? decision.control,
      },
      latencyMs: Date.now() - started,
    }
    if (booleanFlag(args, '--json')) {
      console.log(JSON.stringify(output, null, 2))
      return
    }
    const target = decision.action
      ? ` ${decision.action.ref} ${JSON.stringify(decision.action.label)}`
      : decision.control
        ? ` ${decision.control.label}`
        : ''
    console.log(`${decision.operation}${target}`)
    console.log(`confidence ${decision.confidence.toFixed(2)}, ${output.latencyMs}ms`)
  })
}

async function agentCommand(args: Args): Promise<void> {
  const goal = flag(args, '--goal') ?? args.positionals[0]
  if (!goal) fail('NOT_INTERACTABLE', 'agent needs --goal')
  const dryRun = booleanFlag(args, '--dry-run')
  const config = modelOptions(args, 'jev', !dryRun)
  const text = modelOptions(args, 'text', !dryRun)
  const asJson = booleanFlag(args, '--json')
  await withSession(args, async (session) => {
    const result = await run(session, {
      jev: config,
      text: text.model ? text : undefined,
      goal,
      maxSteps: numberFlag(args, ['--max-steps'], 20),
      fills: fillsOf(args),
      uploads: uploadsOf(args),
      dryRun,
      onStep: (step) => {
        if (asJson) return
        if (step.needs) {
          console.error(`[${step.step}] needs ${step.needs.kind} for ${step.needs.label}; action not executed`)
          return
        }
        const what = step.action ?? step.operation
        const changed = step.pageChanged === false ? ' (no change)' : ''
        console.error(`[${step.step}] ${step.operation} ${what}${changed} ${step.latencyMs ?? 0}ms`)
      },
    })
    if (asJson) {
      console.log(JSON.stringify(result, null, 2))
      return
    }
    console.log(`${result.status} after ${result.steps} step(s), ${result.url}`)
    if (result.hint) console.log(`hint: ${result.hint}`)
    if (result.needs?.kind === 'file')
      console.log(`needs a file for ${result.needs.label}; rerun with --upload '${result.needs.label}=/path/to/file'`)
    else if (result.needs)
      console.log(`needs text for ${result.needs.label}; rerun with --fill '${result.needs.label}=...'`)
  })
}

async function skillCommand(): Promise<void> {
  console.log(fileURLToPath(new URL('../skills/chrome-use/SKILL.md', import.meta.url)))
}

const COMMANDS: Record<string, Command> = {
  start: startCommand,
  stop: stopCommand,
  status: statusCommand,
  close: closeCommand,
  ...Object.fromEntries(Object.keys(SNAPSHOT_ACTIONS).map((name) => [name, snapshotCommand(name)])),
  press: pressCommand,
  point: pointCommand,
  eval: evalCommand,
  js: jsCommand,
  screenshot: screenshotCommand,
  cdp: cdpCommand,
  decide: decideCommand,
  agent: agentCommand,
  skill: skillCommand,
}

async function main(argv: string[]): Promise<void> {
  setGlobalProxyFromEnv()
  const help = argv.length === 0 || argv[0] === 'help' || argv.some((a) => a === '--help' || a === '-h')
  if (help) {
    console.log(USAGE)
    return
  }
  const [command, ...rest] = argv
  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(version())
    return
  }
  const handler = COMMANDS[command]
  if (!handler) fail('NOT_INTERACTABLE', `Unknown command ${command}; run chrome-use --help`)
  await handler(parseArgs(rest))
}

main(process.argv.slice(2)).catch((error) => {
  if (error instanceof ChromeUseError) {
    console.error(`chrome-use: ${error.code}: ${error.message}`)
    process.exit(1)
  }
  console.error(`chrome-use: ${messageOf(error)}`)
  process.exit(1)
})
