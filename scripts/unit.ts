// Pure logic, no browser: the request the model answers and the answers we accept.
//   node --test scripts/unit.ts

import type { Session, Snapshot } from '../src/index.ts'

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import { buildRequest, ChromeUseError, collectActions, readDecision, run, validateAnswer } from '../src/index.ts'

interface Answer {
  choice: string
  probabilities: Record<string, number>
  confidence: number
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    url: 'https://example.com/',
    title: 'Example',
    w: 1280,
    h: 800,
    text: 'Search\nResults',
    scroll: { y: 0, height: 4000 },
    history: 2,
    hiddenFrames: 0,
    truncated: 0,
    dialogs: 0,
    elements: [
      { ref: 'e1-tok', role: 'textbox', label: 'Query', operations: ['TYPE_TEXT', 'CLICK'], value: '' },
      { ref: 'e2-tok', role: 'button', label: 'Search', operations: ['CLICK'] },
      { ref: 'e3-tok', role: 'combobox', label: 'Sort', operations: ['SELECT'], value: 'new' },
      { ref: 'e4-tok', role: 'file', label: 'Receipt', operations: ['UPLOAD'] },
    ],
    actions: [
      { ref: 'e1-tok', kind: 'fill', label: 'Query', value: '' },
      { ref: 'e1-tok', kind: 'click', label: 'Open Query', value: '' },
      { ref: 'e2-tok', kind: 'click', label: 'Search', value: '' },
      { ref: 'e3-tok', kind: 'select', label: 'Sort → Newest', value: 'new', current_value: 'Best match' },
      { ref: 'e4-tok', kind: 'upload', label: 'Receipt', value: '' },
    ],
    ...overrides,
  }
}

/** A calibrated answer over every offered key, the way the endpoint returns one. */
function choice(id: string, keys: string[], confidence = 0.9): Answer {
  const rest = (1 - confidence) / Math.max(1, keys.length - 1)
  const probabilities = Object.fromEntries(keys.map((key) => [key, key === id ? confidence : rest]))
  return { choice: id, probabilities, confidence }
}

test('collectActions groups targets and controls by operation', () => {
  const table = collectActions(snapshot(), {
    tabs: [{ id: 'other', url: 'https://b.test/', title: 'B' }],
    current: 'e1-tok',
  })
  assert.deepEqual(Object.keys(table.targets.CLICK), ['e1-tok', 'e2-tok'])
  assert.deepEqual(Object.keys(table.targets.TYPE_TEXT), ['e1-tok'])
  assert.deepEqual(Object.keys(table.targets.SELECT), ['e3-tok:1'])
  assert.deepEqual(Object.keys(table.targets.UPLOAD), ['e4-tok'])
  assert.equal(table.targets.SELECT['e3-tok:1']?.current_value, 'Best match')
  assert.equal(table.controls.SCROLL_DOWN?.kind, 'scroll')
  assert.equal(table.controls.BACK?.kind, 'back')
  assert.deepEqual(table.controls.SWITCH_1, {
    key: 'SWITCH_1',
    kind: 'switch',
    label: 'Switch to tab: B (https://b.test/)',
    tabId: 'other',
  })
})

test('collectActions drops controls the page does not need', () => {
  const table = collectActions(snapshot({ scroll: { y: 0, height: 800 }, history: 1 }), {})
  assert.equal(table.controls.SCROLL_DOWN, undefined)
  assert.equal(table.controls.BACK, undefined)
  assert.equal(table.controls.SWITCH_1, undefined)
  assert.ok(table.controls.WAIT)
})

test('buildRequest offers only the operations the page has', () => {
  const snap = snapshot()
  const request = buildRequest({ goal: 'search', snap, table: collectActions(snap) })
  assert.equal(request.model, 'typesafe/jev')
  assert.deepEqual(Object.keys(request.questions.operation?.criteria).sort(), [
    'BACK',
    'BLOCKED',
    'CLICK',
    'DONE',
    'SCROLL_DOWN',
    'SELECT',
    'TYPE_TEXT',
    'UPLOAD',
    'WAIT',
  ])
  assert.deepEqual(Object.keys(request.questions.select_target?.criteria), ['e3-tok:1'])
  assert.equal(request.state.page.viewport.h, 800)
  assert.equal(request.state.page.scroll.height, 4000)
})

test('buildRequest omits a target group when the page cannot do it', () => {
  const snap = snapshot({ actions: [{ ref: 'e2-tok', kind: 'click', label: 'Search', value: '' }] })
  const request = buildRequest({ goal: 'search', snap, table: collectActions(snap) })
  assert.equal(request.questions.type_text_target, undefined)
  assert.equal(request.questions.select_target, undefined)
})

test('readDecision maps an answer back to one action', () => {
  const snap = snapshot()
  const table = collectActions(snap)
  const request = buildRequest({ goal: 'search', snap, table })
  const operation = choice('CLICK', Object.keys(request.questions.operation?.criteria))
  const target = choice('e2-tok', Object.keys(request.questions.click_target?.criteria))
  const decision = readDecision({ answers: { operation, click_target: target } }, table)
  assert.equal(decision.kind, 'action')
  assert.equal(decision.action?.label, 'Search')
})

test('readDecision rejects an answer outside the offered keys', () => {
  const table = collectActions(snapshot())
  const operation = choice('NAVIGATE', ['CLICK'])
  assert.throws(() => readDecision({ answers: { operation } }, table), ChromeUseError)
})

test('validateAnswer rejects probabilities that do not cover the keys', () => {
  assert.throws(
    () => validateAnswer({ choice: 'A', confidence: 0.9, probabilities: { A: 0.9 } }, ['A', 'B']),
    ChromeUseError,
  )
  assert.throws(
    () => validateAnswer({ choice: 'A', confidence: 0.9, probabilities: { A: 0.4, B: 0.4 } }, ['A', 'B']),
    ChromeUseError,
  )
  assert.throws(
    () => validateAnswer({ choice: 'A', confidence: 0.9, probabilities: { A: 0.2, B: 0.8 } }, ['A', 'B']),
    ChromeUseError,
  )
  assert.equal(
    validateAnswer({ choice: 'B', confidence: 0.9, probabilities: { A: 0.2, B: 0.8 } }, ['A', 'B']).choice,
    'B',
  )
})

test('run sends each model its own URL, credentials, model and timeout', async (t) => {
  const snap = snapshot()
  snap.elements[0].context = 'Search the web'
  const table = collectActions(snap)
  const calls: Array<{ url: string; key: string | null; model: unknown; signal: AbortSignal | null | undefined }> = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({
      url,
      key: new Headers(init.headers).get('Authorization'),
      model: JSON.parse(String(init.body)).model,
      signal: init.signal,
    })
    if (calls.length === 2) {
      const body = JSON.parse(String(init.body))
      const input = JSON.parse(body.messages[1].content)
      assert.deepEqual(input.field, { label: 'Query', value: '', role: 'textbox', context: 'Search the web' })
      assert.equal(input.page.url, snap.url)
    }
    return Response.json(
      calls.length === 1
        ? {
            answers: {
              operation: choice('TYPE_TEXT', [
                ...Object.keys(table.targets),
                ...Object.keys(table.controls),
                'DONE',
                'BLOCKED',
              ]),
              type_text_target: choice('e1-tok', ['e1-tok'], 1),
            },
          }
        : { choices: [{ message: { content: '{"text":null}' } }] },
    )
  })
  const session = { snap: async () => snap, tabs: async () => [] } as unknown as Session
  const result = await run(session, {
    goal: 'search',
    jev: { baseUrl: 'https://jev.test/v1/', apiKey: 'jev-key', model: 'custom-jev', timeout: 1000 },
    text: { baseUrl: 'https://text.test/v2', apiKey: 'text-key', model: 'custom-text', timeout: 2000 },
  })
  assert.equal(result.status, 'needs')
  assert.deepEqual(result.needs, { kind: 'text', ref: 'e1-tok', label: 'Query' })
  assert.deepEqual(
    calls.map(({ url, key, model }) => ({ url, key, model })),
    [
      { url: 'https://jev.test/v1/systemone', key: 'Bearer jev-key', model: 'custom-jev' },
      { url: 'https://text.test/v2/chat/completions', key: 'Bearer text-key', model: 'custom-text' },
    ],
  )
  assert.ok(calls.every((call) => call.signal instanceof AbortSignal))
  assert.notEqual(calls[0]?.signal, calls[1]?.signal)
})

test('CLI rejects partial text configuration without borrowing Jev credentials', () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('CHROME_USE_') && key !== 'TYPESAFE_API_KEY' && key !== 'OPENAI_API_KEY',
    ),
  )
  const result = spawnSync(
    process.execPath,
    [
      'src/cli.ts',
      'agent',
      '--goal',
      'search',
      '--jev-base-url',
      'https://jev.test',
      '--jev-api-key',
      'jev-key',
      '--text-model',
      'text-model',
    ],
    { env, encoding: 'utf8' },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /MODEL_ERROR/)
  assert.doesNotMatch(result.stderr, /--text-base-url/)
  assert.match(result.stderr, /--text-api-key/)
  assert.doesNotMatch(result.stderr, /--jev-base-url/)
})

test('CLI resolves fields independently and lets flags override environment values', () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('CHROME_USE_') && key !== 'TYPESAFE_API_KEY' && key !== 'OPENAI_API_KEY',
    ),
  )
  const result = spawnSync(process.execPath, ['src/cli.ts', 'agent', '--goal', 'search', '--text-model='], {
    env: {
      ...env,
      CHROME_USE_JEV_BASE_URL: 'https://jev.test',
      CHROME_USE_JEV_API_KEY: 'jev-key',
      CHROME_USE_TEXT_BASE_URL: 'https://text.test',
      CHROME_USE_TEXT_API_KEY: 'text-key',
      CHROME_USE_TEXT_MODEL: 'environment-model',
    },
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Missing model configuration: --text-model/)
  assert.doesNotMatch(result.stderr, /--text-base-url|--text-api-key|--jev-/)
})

test('CLI uses provider keys and default URLs, with CHROME_USE keys as fallback', () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('CHROME_USE_') && key !== 'TYPESAFE_API_KEY' && key !== 'OPENAI_API_KEY',
    ),
  )
  for (const keys of [
    { TYPESAFE_API_KEY: 'jev-key', OPENAI_API_KEY: 'text-key' },
    { CHROME_USE_JEV_API_KEY: 'jev-key', CHROME_USE_TEXT_API_KEY: 'text-key' },
    {
      TYPESAFE_API_KEY: '',
      OPENAI_API_KEY: '',
      CHROME_USE_JEV_API_KEY: 'jev-key',
      CHROME_USE_TEXT_API_KEY: 'text-key',
    },
    {
      TYPESAFE_API_KEY: 'jev-key',
      OPENAI_API_KEY: 'text-key',
      CHROME_USE_JEV_API_KEY: '',
      CHROME_USE_TEXT_API_KEY: '',
    },
  ]) {
    const result = spawnSync(process.execPath, ['src/cli.ts', 'agent', '--goal', 'search', '--text-model='], {
      env: { ...env, ...keys },
      encoding: 'utf8',
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Missing model configuration: --text-model/)
    assert.doesNotMatch(result.stderr, /--text-base-url|--text-api-key|--jev-/)
  }
  const result = spawnSync(process.execPath, ['src/cli.ts', 'decide', '--goal', 'search', '--jev-api-key='], {
    env: { ...env, TYPESAFE_API_KEY: 'provider-key', CHROME_USE_JEV_API_KEY: 'fallback-key' },
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Missing model configuration: --jev-api-key/)
  assert.doesNotMatch(result.stderr, /--jev-base-url/)
})
