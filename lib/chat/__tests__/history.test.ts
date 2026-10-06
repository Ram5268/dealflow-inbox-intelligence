// Brief 41 (H3, M18) — Drift's memory and side-channel blocks. Pure: an
// in-memory stand-in for prisma.chatMessage.findMany, plus source checks for
// the route and the context fetchers (which import Prisma, so can't load here).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HISTORY_LIMIT, oldestFirst, recentHistoryQuery } from '../history'

const ROOT = join(__dirname, '..', '..', '..')

interface Msg { id: string; sessionId: string; role: 'user' | 'assistant'; content: string; createdAt: Date }

// 20 exchanges: user turn n and Drift's reply n.
const t0 = Date.parse('2026-10-05T12:00:00Z')
const messages: Msg[] = Array.from({ length: 40 }, (_, i) => ({
  id: `m${String(i + 1).padStart(3, '0')}`,
  sessionId: 's1',
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `${i % 2 === 0 ? 'user' : 'drift'} turn ${Math.floor(i / 2) + 1}`,
  createdAt: new Date(t0 + i * 1000),
}))

// Applies Prisma's where / orderBy (array of { field: dir }) / take semantics.
function findMany(args: { where: { sessionId: string }; orderBy: unknown; take: number }): Msg[] {
  const keys = (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) as Array<Record<string, 'asc' | 'desc'>>
  return messages
    .filter(m => m.sessionId === args.where.sessionId)
    .sort((a, b) => {
      for (const k of keys) {
        const [field, dir] = Object.entries(k)[0] as [keyof Msg, 'asc' | 'desc']
        const av = a[field] instanceof Date ? (a[field] as Date).getTime() : String(a[field])
        const bv = b[field] instanceof Date ? (b[field] as Date).getTime() : String(b[field])
        if (av !== bv) return (av < bv ? -1 : 1) * (dir === 'asc' ? 1 : -1)
      }
      return 0
    })
    .slice(0, args.take)
}

test('Drift remembers the newest 30 messages, oldest first', () => {
  const history = oldestFirst(findMany(recentHistoryQuery('s1')))
  assert.equal(HISTORY_LIMIT, 30)
  assert.equal(history.length, 30)
  assert.equal(history[0].content, 'user turn 6')
  assert.equal(history[29].content, 'drift turn 20')
  // what the route reads as "the last thing Drift said" is the latest reply
  assert.equal(history.filter(m => m.role === 'assistant').slice(-1)[0].content, 'drift turn 20')
  // turn 17 can see turn 16
  assert.ok(history.some(m => m.content === 'drift turn 16'))
})

test('the old query (oldest 30) is what lost the recent turns', () => {
  const old = findMany({ where: { sessionId: 's1' }, orderBy: { createdAt: 'asc' }, take: 30 })
  assert.equal(old[29].content, 'drift turn 15')
  assert.ok(!old.some(m => m.content === 'drift turn 16'))
})

test('same-millisecond messages keep one order (id breaks the tie)', () => {
  const q = recentHistoryQuery('s1')
  assert.deepEqual(q.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }])
})

test('the chat route loads history through these helpers', () => {
  const route = readFileSync(join(ROOT, 'app/api/chat/route.ts'), 'utf8')
  assert.match(route, /const history = oldestFirst\(await prisma\.chatMessage\.findMany\(recentHistoryQuery\(session\.id\)\)\)/)
  assert.doesNotMatch(route, /orderBy: \{ createdAt: 'asc' \},\s*take: 30/)
})

test('chat context blocks only read: no side-channel fetcher writes to the DB (M18)', () => {
  const dir = join(ROOT, 'lib/chat/context')
  const writes = /\.(update|updateMany|upsert|create|createMany|delete|deleteMany)\(/
  for (const f of readdirSync(dir).filter(f => f.endsWith('.ts'))) {
    assert.doesNotMatch(readFileSync(join(dir, f), 'utf8'), writes, f)
  }
})
