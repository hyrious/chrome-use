export type ErrorCode =
  | 'RUNTIME'
  | 'CHROME_NOT_FOUND'
  | 'CHROME_EXITED'
  | 'PROFILE_IN_USE'
  | 'PORT_IN_USE'
  | 'NOT_RUNNING'
  | 'NETWORK'
  | 'CDP_CLOSED'
  | 'TIMEOUT'
  | 'NO_TARGET'
  | 'STALE'
  | 'NOT_INTERACTABLE'
  | 'EVAL_ERROR'
  | 'SCRIPT_ERROR'
  | 'INVALID_DECISION'
  | 'MODEL_ERROR'
  | 'NEEDS_TEXT'

export class ChromeUseError extends Error {
  code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'ChromeUseError'
    this.code = code
  }
}

export function fail(code: ErrorCode, message: string): never {
  throw new ChromeUseError(code, message)
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
