import { ChromeUseError, fail } from './errors.ts'

export interface BrowserInfo {
  webSocketDebuggerUrl: string
  Browser?: string
  'User-Agent'?: string
  'Protocol-Version'?: string
}

export interface TargetInfo {
  id: string
  type: string
  url: string
  title: string
  webSocketDebuggerUrl?: string
}

/** An event pushed by CDP; each listener names the fields it reads. */
export interface CdpEvent {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

interface CdpMessage {
  id: number
  result?: unknown
  error?: unknown
}

interface CdpEventPayload {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

interface SendPayload {
  id: number
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

function endpointOf(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`
}

async function getJson<T>(url: string, timeout: number): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeout) })
  } catch {
    fail('NOT_RUNNING', `Chrome is not listening on ${url}`)
  }
  if (!response.ok) fail('NOT_RUNNING', `Chrome answered ${response.status} on ${url}`)
  return (await response.json()) as T
}

/** Reads `GET /json/version`, the cheapest way to tell whether CDP is up. */
export function browserInfo(port: number, timeout = 2000): Promise<BrowserInfo> {
  return getJson<BrowserInfo>(endpointOf(port, '/json/version'), timeout)
}

/** Lists page targets, hiding devtools and extension pages. */
export async function listTargets(port: number, timeout = 4000): Promise<TargetInfo[]> {
  const targets = await getJson<TargetInfo[]>(endpointOf(port, '/json/list'), timeout)
  return targets.filter((target) => target.type === 'page' && !/^(devtools|chrome-extension|chrome):/.test(target.url))
}

function protocolError(error: unknown): ChromeUseError {
  const { message, data } = (error ?? {}) as { message?: string; data?: unknown }
  const detail = data ? ` (${String(data)})` : ''
  return new ChromeUseError('EVAL_ERROR', `${message ?? 'CDP call failed'}${detail}`)
}

async function openSocket(wsUrl: string, timeout: number): Promise<WebSocket> {
  if (typeof WebSocket !== 'function') {
    fail('RUNTIME', 'chrome-use requires Node 22.4 or newer (global WebSocket is missing)')
  }
  const ws = new WebSocket(wsUrl)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ChromeUseError('TIMEOUT', `CDP did not open ${wsUrl} in ${timeout}ms`)),
      timeout,
    )
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new ChromeUseError('CDP_CLOSED', `Cannot connect to ${wsUrl}`))
    })
  })
  return ws
}

/** One WebSocket to the browser endpoint, flat sessions, method based events. */
export class CDP {
  private ws: WebSocket
  private pending: Map<number, Pending> = new Map()
  private listeners: Set<(event: CdpEvent) => void> = new Set()
  private nextId = 1
  private closed = false

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (event) => this.receive(event))
    ws.addEventListener('close', () => this.abort(new ChromeUseError('CDP_CLOSED', 'Chrome closed the CDP connection')))
    ws.addEventListener('error', () => this.abort(new ChromeUseError('CDP_CLOSED', 'CDP connection failed')))
  }

  static async open(wsUrl: string, timeout = 10_000): Promise<CDP> {
    return new CDP(await openSocket(wsUrl, timeout))
  }

  /** The caller names the shape it expects; CDP answers are only checked on the wire. */
  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeout = 30_000,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new ChromeUseError('CDP_CLOSED', 'CDP connection is closed'))
    }
    const id = this.nextId++
    const payload: SendPayload = { id, method, params, sessionId }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new ChromeUseError('TIMEOUT', `${method} did not answer in ${timeout}ms`))
      }, timeout)
      // The id map cannot carry the type parameter, so the value is stored untyped.
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.ws.send(JSON.stringify(payload))
    })
  }

  on(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async attach(targetId: string): Promise<string> {
    const result = await this.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    return result.sessionId
  }

  close(): void {
    this.abort(new ChromeUseError('CDP_CLOSED', 'closed'))
    try {
      this.ws.close()
    } catch {}
  }

  private receive(event: MessageEvent): void {
    if (typeof event.data !== 'string') return
    const data = JSON.parse(event.data) as CdpMessage | CdpEventPayload
    if ('id' in data) {
      this.settle(data)
      return
    }
    for (const listener of this.listeners) listener(data)
  }

  private settle(data: CdpMessage): void {
    const pending = this.pending.get(data.id)
    if (!pending) return
    this.pending.delete(data.id)
    clearTimeout(pending.timer)
    if (data.error) pending.reject(protocolError(data.error))
    else pending.resolve(data.result)
  }

  private abort(error: ChromeUseError): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
