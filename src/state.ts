import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

import { appHome, statePath } from './paths.ts'

/** What chrome-use remembers between commands. */
export interface AppState {
  pid: number
  port: number
  chrome: string
  profile: string
  startedAt: string
  /** The tab the last command worked in. */
  tab?: string
}

function isAppState(value: unknown): value is AppState {
  if (typeof value !== 'object' || value == null) return false
  const state = value as Record<string, unknown>
  return typeof state.port === 'number' && typeof state.profile === 'string'
}

export function readState(): AppState | null {
  try {
    const state = JSON.parse(readFileSync(statePath(), 'utf8'))
    return isAppState(state) ? state : null
  } catch {
    return null
  }
}

export function writeState(state: AppState): void {
  mkdirSync(appHome(), { recursive: true })
  writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`)
}

export function clearState(): void {
  rmSync(statePath(), { force: true })
}
