// Brief 43 PR 17: an in-memory stand-in for the Prisma calls the spend guards
// and the guarded routes make (chat, retitle, tts, transcribe, voice session),
// plus a fetch stand-in that counts every outside call. Import this FIRST in a
// test file: it sets globalThis.prisma before lib/prisma loads, so no database
// client is ever created. Not a *.test.ts file.
//
// The `where` matcher understands only the shapes these routes use: equality,
// `{ gte }`, `{ not }`, a JSON `path`/`equals` filter, `AND`, and a relation
// `{ some: {...} }` filter on ChatSession.messages.
export type Row = Record<string, unknown>

export const ORG = 'org_pr17'

function get(row: Row, path: string[]): unknown {
  let v: unknown = row
  for (const p of path) v = v && typeof v === 'object' ? (v as Row)[p] : undefined
  return v
}

function matches(row: Row, where: Row | undefined, related: (k: string, row: Row) => Row[]): boolean {
  for (const [k, cond] of Object.entries(where ?? {})) {
    if (k === 'AND') {
      if (!(cond as Row[]).every(w => matches(row, w, related))) return false
      continue
    }
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Row
      if ('some' in c) {
        if (!related(k, row).some(r => matches(r, c.some as Row, related))) return false
        continue
      }
      const v = 'path' in c ? get((row[k] ?? {}) as Row, c.path as string[]) : row[k]
      if ('equals' in c && v !== c.equals) return false
      if ('gte' in c && !(v instanceof Date && v.getTime() >= (c.gte as Date).getTime())) return false
      if ('not' in c && v === c.not) return false
      continue
    }
    if (row[k] !== cond) return false
  }
  return true
}

const pick = (row: Row, select?: Row): Row =>
  select ? Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]])) : { ...row }

export function fakePrisma() {
  const data = {
    auditLog: [] as Row[],
    chatSession: [] as Row[],
    chatMessage: [] as Row[],
    driftInteraction: [] as Row[],
  }
  const calls: string[] = []         // "model.op", in order
  const failing = new Set<string>()  // "model.op" entries that throw (a DB hiccup)
  let nextId = 1

  const related = (k: string, row: Row): Row[] =>
    k === 'messages' ? data.chatMessage.filter(m => m.sessionId === row.id) : []
  const where = (row: Row, w?: Row) => matches(row, w, related)

  function op<T>(name: string, fn: () => T): Promise<T> {
    calls.push(name)
    if (failing.has(name)) return Promise.reject(new Error(`test: ${name} failed (simulated DB hiccup)`))
    return Promise.resolve(fn())
  }

  const db = {
    organization: { findUnique: () => op('organization.findUnique', () => ({ id: ORG })) },
    auditLog: {
      findMany: (a: { where?: Row; select?: Row }) =>
        op('auditLog.findMany', () => data.auditLog.filter(r => where(r, a.where)).map(r => pick(r, a.select))),
      count: (a: { where?: Row }) => op('auditLog.count', () => data.auditLog.filter(r => where(r, a.where)).length),
      create: (a: { data: Row }) => op('auditLog.create', () => {
        const row = { id: `audit_${nextId++}`, createdAt: new Date(), ...a.data }
        data.auditLog.push(row)
        return row
      }),
    },
    driftInteraction: {
      aggregate: (a: { where?: Row; _sum: { costUsd: true } }) => op('driftInteraction.aggregate', () => {
        const rows = data.driftInteraction.filter(r => where(r, a.where))
        return { _sum: { costUsd: rows.length ? rows.reduce((s, r) => s + Number(r.costUsd ?? 0), 0) : null } }
      }),
    },
    chatSession: {
      findMany: (a: { where?: Row; orderBy?: Row; take?: number; include?: Row }) => op('chatSession.findMany', () => {
        let rows = data.chatSession.filter(r => where(r, a.where))
        const [key, dir] = Object.entries(a.orderBy ?? {})[0] ?? []
        if (key) rows = [...rows].sort((x, y) => ((x[key] as Date).getTime() - (y[key] as Date).getTime()) * (dir === 'desc' ? -1 : 1))
        if (a.take != null) rows = rows.slice(0, a.take)
        return rows.map(r => ({ ...r, messages: a.include?.messages ? related('messages', r) : undefined }))
      }),
      findUnique: (a: { where: Row }) => op('chatSession.findUnique', () => data.chatSession.find(r => where(r, a.where)) ?? null),
      create: (a: { data: Row }) => op('chatSession.create', () => {
        const row = { id: `session_${nextId++}`, title: null, archived: false, createdAt: new Date(), updatedAt: new Date(), ...a.data }
        data.chatSession.push(row)
        return row
      }),
      update: (a: { where: { id: string }; data: Row }) => op('chatSession.update', () => {
        const row = data.chatSession.find(r => r.id === a.where.id)
        if (!row) throw new Error('test: no such session')
        Object.assign(row, a.data)
        return row
      }),
    },
    chatMessage: {
      findMany: (a: { where?: Row }) => op('chatMessage.findMany', () => data.chatMessage.filter(r => where(r, a.where))),
      create: (a: { data: Row }) => op('chatMessage.create', () => {
        const row = { id: `msg_${nextId++}`, createdAt: new Date(), ...a.data }
        data.chatMessage.push(row)
        return row
      }),
    },
  }
  return { db, data, calls, failing }
}

// The current fake, swappable between cases; lib/prisma reads through this proxy.
export const current = { fake: fakePrisma() }
;(globalThis as unknown as { prisma: unknown }).prisma = new Proxy({}, {
  get: (_t, prop) => (current.fake.db as unknown as Record<string | symbol, unknown>)[prop],
})

export const urlOf = (input: unknown) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url: string }).url

// Counts every outside call (any URL) before handing it to the fetch underneath
// (the shared fakeAiFetch, or a stub). A multipart body (transcription, voice)
// can't be parsed as JSON by fakeAiFetch, so count here rather than trust its
// `requests` list. The OpenAI SDK's local `data:,` probe (does this fetch
// handle FormData?) isn't a network call and isn't counted.
export function countFetches() {
  const inner = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = urlOf(input)
    if (!url.startsWith('data:')) urls.push(url.split(/[?#]/)[0])
    return inner(input as RequestInfo, init)
  }) as typeof fetch
  return urls
}
