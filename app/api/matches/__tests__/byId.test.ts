import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

// Brief 38: GET /api/matches?id=<id> opens one match even when it sits outside
// the list's first 200 (the list sorts unseen first, then score, then newest).
// Runs under tsx against an in-memory stand-in for Prisma; no database.

type Row = Record<string, unknown> & { id: string; organizationId: string; score: number; seen: boolean; createdAt: Date }
const ORG = 'org_b38'
const rows: Row[] = Array.from({ length: 250 }, (_, i) => ({
  id: `match_${String(i).padStart(3, '0')}`, organizationId: ORG, score: 99 - Math.floor(i / 10), seen: false,
  createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, i)), reason: 'neighborhood + beds + propertyType', tier: 'HOT',
  counterpartType: 'opportunity', counterpartId: `buyer_${i}`, opportunityId: `seller_${i}`, opportunityType: 'contact',
}))
// The target: seen and low-scoring, so it sorts last and fails the unseen/score filters.
const target = rows[249]
Object.assign(target, { seen: true, score: 51 })
rows.push({ ...rows[0], id: 'match_other_org', organizationId: 'org_other' })

function where(row: Record<string, unknown>, w: Record<string, unknown>): boolean {
  return Object.entries(w).every(([k, v]) =>
    v && typeof v === 'object' && 'gte' in v ? (row[k] as number) >= (v as { gte: number }).gte : row[k] === v)
}
type Order = Record<string, 'asc' | 'desc'>
function compare(orderBy: Order[]) {
  return (a: Record<string, unknown>, b: Record<string, unknown>) => {
    for (const o of orderBy) {
      const [k, dir] = Object.entries(o)[0]
      const x = a[k] instanceof Date ? (a[k] as Date).getTime() : Number(a[k])
      const y = b[k] instanceof Date ? (b[k] as Date).getTime() : Number(b[k])
      if (x !== y) return dir === 'asc' ? x - y : y - x
    }
    return 0
  }
}
const pick = (row: Record<string, unknown>, select?: Record<string, boolean>) =>
  select ? Object.fromEntries(Object.keys(select).map(k => [k, row[k]])) : row

let dismissalLookups = 0
const fakePrisma = {
  organization: { findUnique: async () => ({ id: ORG }) },
  match: {
    findMany: async (args: { where: Record<string, unknown>; orderBy: Order[]; take: number; select: Record<string, boolean> }) =>
      rows.filter(r => where(r, args.where)).sort(compare(args.orderBy)).slice(0, args.take).map(r => pick(r, args.select)),
  },
  // The target's pair is dismissed; no other pair is.
  matchDismissal: {
    findMany: async (args: { where: { OR: Array<Record<string, string>> } }) => {
      dismissalLookups++
      return args.where.OR.filter(k => Object.values(k).some(v => v === target.counterpartId || v === target.opportunityId))
    },
  },
  extractedOpportunity: { findMany: async () => [] },
  mojoContact: { findMany: async () => [] },
}
;(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma

async function get(query: string) {
  const { GET } = await import('../route')
  const res = await GET(new NextRequest(`http://localhost/api/matches${query}`))
  assert.equal(res.status, 200)
  return await res.json() as { matches: Array<{ id: string; score: number }>; counts: { total: number } }
}

test('the list stops at 200 and never reaches the target', async () => {
  const { matches } = await get('?includeDismissed=1')
  assert.equal(matches.length, 200)
  assert.ok(!matches.some(m => m.id === target.id))
})

test('?id= opens a match outside the first 200, in the same item shape', async () => {
  const list = await get('')
  dismissalLookups = 0
  const one = await get(`?id=${target.id}`)
  assert.deepEqual(one.matches.map(m => m.id), [target.id])
  assert.equal(one.matches[0].score, 51)
  assert.deepEqual(Object.keys(one.matches[0]).sort(), Object.keys(list.matches[0]).sort())
  assert.equal(dismissalLookups, 0, 'a dismissed pair still opens from its link')
})

test('?id= ignores the tab, unseen filter and type', async () => {
  const one = await get(`?id=${target.id}&unseen=1&scoreMin=90&type=mojo`)
  assert.deepEqual(one.matches.map(m => m.id), [target.id])
})

test('?id= is org-scoped', async () => {
  const one = await get('?id=match_other_org')
  assert.deepEqual(one.matches, [])
})
