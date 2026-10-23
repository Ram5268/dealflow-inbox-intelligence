// Brief 43 PR 4: a stand-in world for the chat route's tests. Nothing leaves
// this process and no database is touched:
//  - globalThis.prisma is a small in-memory store for the models the route
//    uses (equality `where` only; anything fancier matches every row);
//  - globalThis.fetch answers only api.anthropic.com and api.openai.com, from
//    replies the test scripts in order. A reply can be HANG: the request then
//    waits until its signal aborts, or until the test kills it (as Vercel does
//    at 60 s). A reply can also be a ready-made Response (an API error, say).
//    Every other address is refused.
// Import this FIRST, before the route. Not a *.test.ts file.
import type { AiRequest } from '../../../../lib/__tests__/fakeAiFetch'
import { anthropicText, anthropicTool } from '../../../../lib/__tests__/fakeAiFetch'

type Row = Record<string, unknown>
export const tables: Record<string, Row[]> = {}
/** "<model>.create" → ms of (fake) time the write takes (a slow database). */
export const dbDelayMs: Record<string, number> = {}
const dbWait = async (key: string) => { const ms = dbDelayMs[key]; if (ms) await new Promise(r => setTimeout(r, ms)) }
let nextId = 1

const isPlain = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v)
const matches = (row: Row, where: Row = {}) =>
  Object.entries(where).every(([k, v]) => !isPlain(v) || row[k] === v)

function model(name: string) {
  const rows = () => (tables[name] ??= [])
  const find = (where?: Row) => rows().find(r => matches(r, where)) ?? null
  return {
    findUnique: async ({ where }: { where: Row }) => find(where),
    findFirst: async ({ where }: { where?: Row } = {}) => find(where),
    findMany: async ({ where }: { where?: Row } = {}) => rows().filter(r => matches(r, where)),
    count: async ({ where }: { where?: Row } = {}) => rows().filter(r => matches(r, where)).length,
    create: async ({ data }: { data: Row }) => {
      await dbWait(`${name}.create`)
      const row: Row = { id: `${name}-${nextId++}`, createdAt: new Date(), updatedAt: new Date(), title: null, ...data }
      rows().push(row)
      return row
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = find(where)
      if (!row) throw new Error(`test: no ${name} row to update`)
      return Object.assign(row, data)
    },
    upsert: async ({ where, create }: { where: Row; create: Row }) => find(where) ?? model(name).create({ data: create }),
    delete: async ({ where }: { where: Row }) => {
      const row = find(where)
      if (row) rows().splice(rows().indexOf(row), 1)
      return row
    },
    deleteMany: async ({ where }: { where?: Row } = {}) => {
      const gone = rows().filter(r => matches(r, where))
      tables[name] = rows().filter(r => !gone.includes(r))
      return { count: gone.length }
    },
  }
}
;(globalThis as unknown as { prisma: unknown }).prisma = new Proxy({}, {
  get: (_t, prop) => (typeof prop === 'string' && prop !== 'then' ? model(prop) : undefined),
})

export function resetTables() {
  for (const k of Object.keys(tables)) delete tables[k]
  for (const k of Object.keys(dbDelayMs)) delete dbDelayMs[k]
  tables.organization = [{ id: 'org-test', slug: 'dealflow-ryan' }]
}
resetTables()

export const HANG = Symbol('hang')
type Answer = (req: AiRequest) => unknown

export const ai = (() => {
  const requests: AiRequest[] = []
  let script: Answer[] = []
  let openaiScript: Answer[] = []
  const pending: Array<(e: Error) => void> = []
  let onArrive: Array<(r: AiRequest) => void> = []

  // Unscripted requests get a harmless answer, so the old code under test runs
  // to the end instead of retrying forever: a tool request gets a plain final
  // reply, a fact-check gets "grounded", OpenAI (the chat title) gets a title.
  const fallback: Answer = req =>
    req.url.includes('openai.com')
      ? { id: 'chatcmpl-test', object: 'chat.completion', created: 0, model: 'gpt-4o-mini',
          choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: 'Test Chat Title', refusal: null } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
      : (req.body as { tools?: unknown }).tools
        ? anthropicTool('drift_response', { response: 'Fallback reply.', suggestions: [], referencedDeals: [] })
        : anthropicText(JSON.stringify({ isGrounded: true, flags: [] }))

  globalThis.fetch = (async (input: unknown, init?: { body?: unknown; signal?: AbortSignal | null }) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url: string }).url
    if (!/^https:\/\/api\.(openai|anthropic)\.com\//.test(url)) throw new Error(`test: unexpected network call to ${url.split(/[?#]/)[0]}`)
    const req: AiRequest = { url, body: JSON.parse(String(init?.body ?? '{}')) }
    requests.push(req)
    const arrive = onArrive
    onArrive = []
    arrive.forEach(fn => fn(req))
    const answer = (url.includes('anthropic.com') ? script.shift() : openaiScript.shift()) ?? fallback
    const out = answer(req)
    if (out === HANG) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) return reject(signal.reason)
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        pending.push(reject)
      })
    }
    if (out instanceof Response) return out
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  // Test-only placeholders: the SDKs refuse to start without a key.
  process.env.OPENAI_API_KEY = 'test-only-placeholder'
  process.env.ANTHROPIC_API_KEY = 'test-only-placeholder'

  return {
    requests,
    anthropic: () => requests.filter(r => r.url.includes('anthropic.com')),
    openai: () => requests.filter(r => r.url.includes('openai.com')),
    /** The answers for the next Anthropic requests, in order. */
    script(...answers: Answer[]) { script = answers },
    /** The same for the next OpenAI requests (the chat title). */
    scriptOpenAi(...answers: Answer[]) { openaiScript = answers },
    /** Resolves when the next AI request arrives. */
    arrival: () => new Promise<AiRequest>(resolve => onArrive.push(resolve)),
    /** Fail every hanging request, as Vercel's 60-second stop would. */
    killPending() { pending.splice(0).forEach(reject => reject(new Error('test: the function was stopped'))) },
    reset() { requests.length = 0; script = []; openaiScript = []; pending.length = 0; onArrive = [] },
  }
})()

/** Let pending promise work run (setImmediate is real under mocked timers). */
export async function flush(rounds = 50) {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve))
}
