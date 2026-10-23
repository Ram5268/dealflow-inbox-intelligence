// Brief 43 PR 8 test helper: runs the chat route (POST/GET /api/chat) and the
// "+" report route (POST /api/reports) against an in-memory stand-in for Prisma,
// scripted AI replies (lib/__tests__/fakeAiFetch: OpenAI and Anthropic only,
// every other address refused) and a stand-in Buyer Match generator. No
// database, no network. Import this FIRST: lib/prisma reuses globalThis.prisma
// when it is set. Everyone and everything here is fictional.
import { NextRequest } from 'next/server'
import { installFakeAiFetch, openAiChat, anthropicText, systemPromptOf, type AiRequest } from '../../../../lib/__tests__/fakeAiFetch'
import { GENERATOR_REGISTRY, type SectionResult } from '../../../../lib/reports/generators'

type Row = Record<string, unknown>
type Args = { where?: Row; data?: Row; orderBy?: unknown; select?: Row }

export const db = {
  opportunities: [] as Row[],
  sessions: [] as Row[],
  messages: [] as Row[],
  reports: [] as Row[],
  interactions: [] as Row[],
  crmContacts: [] as Row[], // review r1: CRM contacts search_parties returns (no card on the page)
}
let seq = 0
const newId = (p: string) => `${p}_${++seq}`

// The where shapes the chat tools and the card hydration use: id/category `in`.
function oppMatches(row: Row, where: Row = {}): boolean {
  const id = where.id as { in?: string[] } | undefined
  if (id?.in && !id.in.includes(String(row.id))) return false
  const cat = where.category as { in?: string[] } | undefined
  if (cat?.in && !cat.in.includes(String(row.category))) return false
  return true
}

const models: Record<string, Record<string, (args: Args) => Promise<unknown>>> = {
  organization: { findUnique: async () => ({ id: 'org_pr8' }) },
  mojoContact: { findMany: async () => db.crmContacts },
  chatSession: {
    findUnique: async ({ where }) => db.sessions.find(s => s.id === where?.id) ?? null,
    create: async ({ data }) => { const row = { id: newId('sess'), title: null, ...data }; db.sessions.push(row); return row },
    update: async ({ where, data }) => ({ ...(db.sessions.find(s => s.id === where?.id) ?? {}), ...data }),
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
  extractedOpportunity: {
    findMany: async ({ where }) => db.opportunities.filter(o => oppMatches(o, where)).map(o => ({ rawEmail: null, ...o })),
    findUnique: async ({ where }) => db.opportunities.find(o => o.id === where?.id) ?? null,
  },
  report: {
    create: async ({ data }) => { const row = { id: newId('report'), createdAt: new Date(Date.UTC(2026, 9, 19)), ...data }; db.reports.push(row); return row },
  },
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

// A Buyer Match report for the buyer asked for, with no database or model call.
export function fakeSections(buyerId: string): SectionResult[] {
  const at = '2026-10-19T12:00:00.000Z'
  return [
    { key: 'criteria', title: 'Criteria of record', sources: [{ type: 'inbox', id: buyerId, at }], content: {
      prose: 'Jordan Sample is looking in Park Slope for 2 beds at $1.2M to $1.5M.',
      metrics: [{ label: 'Summary', value: 'Park Slope · 2 beds · $1.2M–$1.5M', source: 'inbox' }] } },
    { key: 'matching-inventory', title: 'Matching inventory', sources: [{ type: 'matcher', at }], content: {
      prose: '3 matches.', metrics: [{ label: 'Matches this period', value: '3' }, { label: 'Clear fits (HOT)', value: '1' }, { label: 'Warm', value: '2' }] } },
    { key: 'curated-matches', title: 'Curated matches', sources: [{ type: 'matcher', at }], content: {
      prose: '1 clear fit.', items: [{ listingId: 'opp_88', address: '88 Example Ave', priceLabel: '$1,450,000' }] } },
    { key: 'near-misses', title: 'Near misses', sources: [{ type: 'matcher', at }], content: {
      prose: '2 near-misses.', items: [{ listingId: 'opp_188', address: '188 Example Ave' }, { listingId: 'opp_12', address: '12 Sample St' }] } },
  ]
}
GENERATOR_REGISTRY['buyer-match'] = {
  full: async ({ buyerId }) => ({
    sections: fakeSections(String(buyerId)), markdown: '# Buyer Match', sources: [],
    subject: 'Jordan Sample · 2026-10-19', matchCount: 1,
  }),
  section: async ({ sectionKey, buyerId }) => fakeSections(String(buyerId)).find(s => s.key === sectionKey) ?? fakeSections(String(buyerId))[3],
}

// Drift's own Anthropic calls take the scripted replies in order; the
// fact-check always says grounded.
export const ai = installFakeAiFetch()
export const script: unknown[] = []
export const driftCalls: AiRequest[] = []
ai.reply(req => {
  if (req.url.includes('openai.com')) {
    return systemPromptOf(req).includes('Generate a 4-7 word title') ? openAiChat('Test Chat') : openAiChat({})
  }
  if (systemPromptOf(req).startsWith('You are a fact-checker')) return anthropicText(JSON.stringify({ isGrounded: true, flags: [] }))
  driftCalls.push(req)
  const next = script.shift()
  if (!next) throw new Error('test: no scripted Drift reply left')
  return next
})

export function reset() {
  db.opportunities = []; db.sessions = []; db.messages = []; db.reports = []; db.interactions = []; db.crmContacts = []
  script.length = 0; driftCalls.length = 0
}

// The conversation Drift's first model call of a turn was given.
export function historySent(call: AiRequest): Array<{ role: string; content: unknown }> {
  return (call.body as { messages: Array<{ role: string; content: unknown }> }).messages
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

export async function postPlusReport(body: Record<string, unknown>) {
  const { POST } = await import('../../reports/route')
  const res = await POST(new NextRequest('http://localhost/api/reports', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}
