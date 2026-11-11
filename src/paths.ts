import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where state and the Chrome profile live. Override everything with CHROME_USE_HOME. */
export function appHome(): string {
  const override = process.env.CHROME_USE_HOME
  if (override) return override
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'chrome-use')
  if (process.platform === 'win32')
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'chrome-use')
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'chrome-use')
}

export function profilePath(): string {
  return join(appHome(), 'chrome-profile')
}

export function statePath(): string {
  return join(appHome(), 'state.json')
}

export function logPath(): string {
  return join(appHome(), 'chrome.log')
}
