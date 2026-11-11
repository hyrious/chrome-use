import type { Session } from './session.ts'

import { fail } from './errors.ts'
import { delay } from './time.ts'

type ScriptBody = (...values: unknown[]) => Promise<unknown>

/** The Function constructor without the module wrapper, so a script can await. */
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...params: string[]) => ScriptBody

/**
 * Runs a script with `cu` bound to the session. This is the escape hatch for a
 * flow that is not worth ten commands, and there is no sandbox: the script runs
 * with the caller's permissions inside this Node process.
 */
export async function runScript(session: Session, code: string): Promise<unknown> {
  let run: ScriptBody
  try {
    run = new AsyncFunction('cu', 'bu', 'sleep', 'console', code)
  } catch (error) {
    fail('SCRIPT_ERROR', `The script does not parse: ${error instanceof Error ? error.message : String(error)}`)
  }
  return run(session, session, delay, console)
}
