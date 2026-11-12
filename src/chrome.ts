import type { ChildProcess } from 'node:child_process'
import type { AppState } from './state.ts'

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync } from 'node:fs'
import { Socket } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { browserInfo, CDP } from './cdp.ts'
import { fail } from './errors.ts'
import { appHome, logPath, profilePath } from './paths.ts'
import { clearState, readState, writeState } from './state.ts'
import { delay } from './time.ts'

const DEFAULT_PORT = 9333

export interface StartOptions {
  url?: string
  port?: number
  profile?: string
  chrome?: string
  proxy?: string
  noproxy?: string
  windowSize?: string
}

export interface StartResult {
  port: number
  pid: number
  chrome: string
  profile: string
  wsUrl: string
  reused: boolean
}

export interface StopOptions {
  force?: boolean
}

export interface StopResult {
  stopped: boolean
  port?: number
}

export interface StatusResult {
  running: boolean
  port: number
  profile: string
  chrome?: string
  pid?: number
  wsUrl?: string
}

function killProcess(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return
  try {
    process.kill(pid, signal)
  } catch {}
}

function firstExisting(files: string[]): string | null {
  for (const file of files) {
    if (file && existsSync(file)) return file
  }
  return null
}

function which(command: string): string | null {
  for (const dir of (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    const file = join(dir, command)
    if (existsSync(file)) return file
  }
  return null
}

function chromeCandidates(): string[] {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ]
  }
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
    return roots.flatMap((root) => (root ? [join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []))
  }
  const commands = ['google-chrome-stable', 'google-chrome']
  return commands.map(which).filter((file): file is string => !!file)
}

/** Chrome is the only supported browser, on purpose. */
export function findChrome(explicit?: string): string {
  if (explicit) {
    if (!existsSync(explicit)) fail('CHROME_NOT_FOUND', `Chrome not found at ${explicit}`)
    return explicit
  }
  const fromEnv = process.env.CHROME_PATH
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const found = firstExisting(chromeCandidates())
  if (!found) fail('CHROME_NOT_FOUND', 'Cannot find Google Chrome; pass --chrome or set CHROME_PATH')
  return found
}

function logTail(): string {
  try {
    return readFileSync(logPath(), 'utf8').trim().split('\n').slice(-8).join('\n')
  } catch {
    return ''
  }
}

async function alive(port: number): Promise<boolean> {
  return browserInfo(port, 500).then(
    () => true,
    () => false,
  )
}

async function portBusy(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = new Socket()
    socket.setTimeout(500)
    socket.once('connect', () => {
      socket.destroy()
      done(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      done(false)
    })
    socket.once('error', () => done(false))
    socket.connect(port, '127.0.0.1')
  })
}

/** Chrome's SingletonLock points at `<hostname>-<pid>`, so a lock from a dead process is harmless. */
function profileInUse(profile: string): boolean {
  let target: string
  try {
    target = readlinkSync(join(profile, 'SingletonLock'))
  } catch {
    return false
  }
  const pid = Number(target.slice(target.lastIndexOf('-') + 1))
  if (!Number.isFinite(pid)) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function launchArgs(options: StartOptions, port: number, profile: string): string[] {
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--hide-crash-restore-bubble',
    '--no-startup-window',
    `--window-size=${options.windowSize ?? '1280,880'}`,
  ]
  const proxy = options.proxy ?? (process.env.HTTPS_PROXY || process.env.https_proxy || '')
  if (proxy) args.push(`--proxy-server=${proxy}`)
  const noproxy = options.noproxy ?? process.env.NO_PROXY
  if (noproxy) {
    const proxyBypassList = noproxy
      .split(/[,\s]+/)
      .filter(Boolean)
      .join(';')
    args.push(`--proxy-bypass-list=${proxyBypassList}`)
  }
  return args
}

function spawnChrome(chrome: string, args: string[]): ChildProcess {
  mkdirSync(appHome(), { recursive: true })
  const fd = openSync(logPath(), 'a')
  const child = spawn(chrome, args, { detached: true, stdio: ['ignore', 'ignore', fd] })
  closeSync(fd)
  child.unref()
  return child
}

function reuseRunning(port: number, chrome: string, profile: string, wsUrl: string): StartResult {
  // Chrome is already up, but the state file can be gone (new shell, cleaned home),
  // so it is rewritten here for the commands that follow. The remembered tab is
  // kept: losing it would send the next command to whichever tab Chrome lists first.
  const stored = readState()
  const existing = stored?.port === port ? stored : null
  const state: AppState = {
    pid: existing?.pid ?? 0,
    port,
    chrome: existing?.chrome ?? chrome,
    profile: existing?.profile ?? profile,
    startedAt: existing?.startedAt ?? new Date().toISOString(),
    tab: existing?.tab,
  }
  writeState(state)
  return { ...state, wsUrl, reused: true }
}

async function waitForCdp(child: ChildProcess, port: number, timeout: number): Promise<string> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const info = await browserInfo(port, 800).catch(() => null)
    if (info) return info.webSocketDebuggerUrl
    if (child.exitCode !== null) {
      fail('CHROME_EXITED', `Chrome exited with code ${child.exitCode}\n${logTail()}`)
    }
    await delay(100)
  }
  fail('TIMEOUT', `Chrome did not expose CDP on port ${port} in ${timeout / 1000}s; see ${logPath()}\n${logTail()}`)
}

export async function start(options: StartOptions = {}): Promise<StartResult> {
  const port = options.port ?? DEFAULT_PORT
  const profile = resolve(options.profile ?? profilePath())
  const chrome = findChrome(options.chrome)

  const running = await browserInfo(port, 500).catch(() => null)
  if (running) return reuseRunning(port, chrome, profile, running.webSocketDebuggerUrl)
  if (await portBusy(port)) {
    fail('PORT_IN_USE', `Port ${port} is used by something that is not Chrome; pass --port with a free port`)
  }
  if (profileInUse(profile)) {
    fail('PROFILE_IN_USE', `Chrome is already using ${profile}; run chrome-use stop first or pass another --profile`)
  }

  mkdirSync(profile, { recursive: true })
  const child = spawnChrome(chrome, launchArgs(options, port, profile))
  const state: AppState = { pid: child.pid ?? 0, port, chrome, profile, startedAt: new Date().toISOString() }
  // The port is recorded before CDP answers, so a Chrome that stalls is still stoppable.
  writeState(state)

  const wsUrl = await waitForCdp(child, port, 20_000)
  const cdp = await CDP.open(wsUrl)
  try {
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
      url: options.url ?? 'about:blank',
      newWindow: true,
      background: true,
    })
    writeState({ ...state, tab: targetId })
  } finally {
    cdp.close()
  }
  return { ...state, wsUrl, reused: false }
}

async function closeBrowser(port: number, state: AppState | null, force: boolean): Promise<void> {
  const info = await browserInfo(port).catch(() => null)
  if (info) {
    const cdp = await CDP.open(info.webSocketDebuggerUrl).catch(() => null)
    if (cdp) {
      await cdp.send('Browser.close').catch(() => {})
      cdp.close()
    }
  }
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && (await alive(port))) await delay(100)
  if (await alive(port)) killProcess(state?.pid, force ? 'SIGKILL' : 'SIGTERM')
}

export async function stop(options: StopOptions = {}): Promise<StopResult> {
  const state = readState()
  const port = state?.port ?? DEFAULT_PORT
  const running = await alive(port)
  if (!running && !state) return { stopped: false }

  if (running) await closeBrowser(port, state, !!options.force)
  else killProcess(state?.pid, 'SIGKILL')

  clearState()
  return { stopped: true, port }
}

export async function status(): Promise<StatusResult> {
  const state = readState()
  const port = state?.port ?? DEFAULT_PORT
  const info = await browserInfo(port, 800).catch(() => null)
  return {
    running: !!info,
    port,
    profile: state?.profile ?? profilePath(),
    chrome: state?.chrome,
    pid: state?.pid,
    wsUrl: info?.webSocketDebuggerUrl,
  }
}
