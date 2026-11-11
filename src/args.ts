import { fail } from './errors.ts'

export interface Args {
  flags: Map<string, string | true>
  all: Map<string, string[]>
  positionals: string[]
}

const BOOLEAN: ReadonlySet<string> = new Set([
  '--json',
  '--full',
  '--dry-run',
  '--force',
  '-f',
  '--help',
  '-h',
  '--version',
  '-v',
])

function remember(all: Map<string, string[]>, name: string, value: string): void {
  const list = all.get(name)
  if (list) list.push(value)
  else all.set(name, [value])
}

/** Reads flags in `--name value`, `--name=value` and `-n value` form, with `--` ending them. */
export function parseArgs(argv: string[]): Args {
  const flags: Map<string, string | true> = new Map()
  const all: Map<string, string[]> = new Map()
  const positionals: string[] = []

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token)
      continue
    }
    const equals = token.indexOf('=')
    if (equals > 0) {
      const name = token.slice(0, equals)
      const value = token.slice(equals + 1)
      flags.set(name, value)
      remember(all, name, value)
      continue
    }
    if (BOOLEAN.has(token)) {
      flags.set(token, true)
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || (next.startsWith('-') && next.length > 1 && !/^-\d/.test(next))) {
      flags.set(token, true)
      continue
    }
    flags.set(token, next)
    remember(all, token, next)
    index++
  }
  return { flags, all, positionals }
}

export function flag(args: Args, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args.flags.get(name)
    if (typeof value === 'string') return value
  }
}

export function booleanFlag(args: Args, ...names: string[]): boolean {
  return names.some((name) => args.flags.get(name) === true)
}

function allFlags(args: Args, name: string): string[] {
  return args.all.get(name) ?? []
}

export function numberFlag(args: Args, names: string[], fallback: number): number {
  const value = flag(args, ...names)
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) fail('NOT_INTERACTABLE', `${names[0]} expects a number`)
  return parsed
}

export function portOf(args: Args): number | undefined {
  const port = flag(args, '--port', '-p')
  return port === undefined ? undefined : Number(port)
}

export function uploadsOf(args: Args): Record<string, string[]> {
  const values: Record<string, string[]> = {}
  for (const item of allFlags(args, '--upload')) {
    const equals = item.indexOf('=')
    if (equals <= 0) fail('NOT_INTERACTABLE', `--upload expects 'Field=/path/to/file', got ${JSON.stringify(item)}`)
    const key = item.slice(0, equals).trim()
    const files = values[key] ?? []
    files.push(item.slice(equals + 1))
    values[key] = files
  }
  return values
}

export function fillsOf(args: Args): Record<string, string> {
  const values: Record<string, string> = {}
  for (const item of allFlags(args, '--fill')) {
    const equals = item.indexOf('=')
    if (equals <= 0) fail('NOT_INTERACTABLE', `--fill expects 'Field=value', got ${JSON.stringify(item)}`)
    values[item.slice(0, equals).trim()] = item.slice(equals + 1)
  }
  return values
}
