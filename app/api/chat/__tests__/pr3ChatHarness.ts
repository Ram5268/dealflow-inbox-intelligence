// Brief 43 PR 3 test helper: runs the chat route (POST/GET /api/chat) against an
// in-memory stand-in for Prisma and scripted AI replies (lib/__tests__/fakeAiFetch:
// OpenAI and Anthropic only, every other address refused). No database, no
// network. Import this FIRST: lib/prisma reuses globalThis.prisma when it is set.
import { NextRequest } from 'next/server'
import { installFakeAiFetch, openAiChat, anthropicText, systemPromptOf, type AiRequest } from '../../../../lib/__tests__/fakeAiFetch'

type Row = Record<string, unknown>
type Args = { where?: Row; data?: Row; orderBy?: unknown }

export const db = {
  mojoContacts: [] as Row[],
  messages: [] as Row[],
  interactions: [] as Row[],
  sessions: [] as Row[],
}
let seq = 0
const newId = (p: string) => `${p}_${++seq}`

const models: Record<string, Record<string, (args: Args) => Promise<unknown>>> = {
  organization: { findUnique: async () => ({ id: 'org_pr3' }) },
  chatSession: {
    // Brief 43 PR 4: a chat's row exists once it has been created (the route
    // now creates it only when it saves something), as in a real database.
    findUnique: async ({ where }) => db.sessions.find(s => s.id === where?.id) ?? null,
    create: async ({ data }) => { const row = { id: 'sess_pr3', title: null, ...data }; db.sessions.push(row); return row },
    update: async ({ data }) => ({ id: 'sess_pr3', ...data }),
  },
  chatMessage: {
    // The route asks for newest first (history); GET asks for oldest first.
    findMany: async ({ where, orderBy }) => {
      const rows = db.messages.filter(m => m.sessionId === where?.sessionId)
      return Array.isArray(orderBy) && JSON.stringify(orderBy[0]).includes('desc') ? [...rows].reverse() : rows
    },
    create: async ({ data }) => {
      const row = { id: newId('msg'), createdAt: new Date(Date.UTC(2026, 9, 19, 12, 0, seq)), ...data }
      db.messages.push(row)
      return row
    },
  },
  mojoContact: { findMany: async () => db.mojoContacts },
  driftInteraction: { create: async ({ data }) => { db.interactions.push(data ?? {}); return { id: newId('int') } } },
}
const anyModel: Record<string, (args: Args) => Promise<unknown>> = {
  findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
  create: async ({ data }) => ({ id: newId('row'), ...data }), update: async ({ data }) => ({ ...data }),
  updateMany: async () => ({ count: 0 }), count: async () => 0,
}
;(globalThis as unknown as { prisma: unknown }).prisma = new Proxy({}, {
  get: (_t, model) => new Proxy(models[String(model)] ?? {}, { get: (m, op) => m[String(op)] ?? anyModel[String(op)] }),
})

// Drift's own Anthropic calls (the tool loop, guard retries, the draft rewrite)
// take the scripted replies in order; the fact-check always says grounded.
export const ai = installFakeAiFetch()
export const script: unknown[] = []
export const driftCalls: AiRequest[] = []
// Review r1: the fact-check's requests, and its verdict (grounded unless a test says otherwise).
export const verifierCalls: AiRequest[] = []
const GROUNDED = () => ({ isGrounded: true, flags: [] as Array<{ claim: string; reason: string }> })
let verifier: (req: AiRequest) => unknown = GROUNDED
export function setVerifier(fn: (req: AiRequest) => unknown) { verifier = fn }
ai.reply(req => {
  if (req.url.includes('openai.com')) {
    return systemPromptOf(req).includes('Generate a 4-7 word title') ? openAiChat('Draft Test Chat') : openAiChat({})
  }
  if (systemPromptOf(req).startsWith('You are a fact-checker')) { verifierCalls.push(req); return anthropicText(JSON.stringify(verifier(req))) }
  driftCalls.push(req)
  const next = script.shift()
  if (!next) throw new Error('test: no scripted Drift reply left')
  return next
})

export function reset() {
  db.mojoContacts = []; db.messages = []; db.interactions = []; db.sessions = []
  script.length = 0; driftCalls.length = 0; verifierCalls.length = 0; verifier = GROUNDED
}

export async function postChat(body: Record<string, unknown>) {
  const { POST } = await import('../route')
  const res = await POST(new NextRequest('http://localhost/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

export async function getChat(sessionId: string) {
  const { GET } = await import('../route')
  const res = await GET(new NextRequest(`http://localhost/api/chat?sessionId=${sessionId}`))
  return await res.json() as { messages: Array<Record<string, unknown>> }
}
