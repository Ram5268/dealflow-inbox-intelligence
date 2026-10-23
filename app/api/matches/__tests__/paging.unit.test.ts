import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

// Brief 48 (PR 12, item 4.4): GET /api/matches pages past its first 200. Each
// reply carries nextCursor (null on the last page); passing it back as ?after=
// gives the next 200 in the same order (unseen first, best score, newest, then
// id). A dismissed pair is still left out, and the pages keep going past it.
// Runs under tsx against an in-memory stand-in for Prisma; no database. Every id
// here is invented.

type Row = Record<string, unknown> & { id: string; organizationId: string; score: number; seen: boolean; createdAt: Date }
const ORG = 'org_b48_pr12'
const rows: Row[] = Array.from({ length: 450 }, (_, i) => ({
  id: `match_${String(i).padStart(3, '0')}`, organizationId: ORG, score: 99 - Math.floor(i / 25), seen: i >= 430,
  createdAt: new Date(Date.UTC(2026, 9, 1 + (i % 3), 9)), reason: 'Right neighborhood', tier: 'HOT',
  counterpartType: 'opportunity', counterpartId: `buyer_${i % 7}`, opportunityId: `seller_${i}`, opportunityType: 'contact',
}))
rows.push({ ...rows[0], id: 'match_other_org', organizationId: 'org_other' })
const DISMISSED = rows[250] // its pair (buyer, seller) is dismissed

type Where = Record<string, unknown>
function fits(row: Record<string, unknown>, w: Where): boolean {
  return Object.entries(w).every(([k, v]) => {
    if (k === 'OR') return (v as Where[]).some(x => fits(row, x))
    const num = (x: unknown) => (x instanceof Date ? x.getTime() : x) as number | string
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const c = v as Record<string, unknown>
      if ('gte' in c) return num(row[k]) >= num(c.gte)
      if ('lt' in c) return num(row[k]) < num(c.lt)
      if ('gt' in c) return num(row[k]) > num(c.gt)
      throw new Error(`unsupported ${JSON.stringify(c)}`)
    }
    return num(row[k]) === num(v)
  })
}
type Order = Record<string, 'asc' | 'desc'>
const compare = (orderBy: Order[]) => (a: Record<string, unknown>, b: Record<string, unknown>) => {
  for (const o of orderBy) {
    const [k, dir] = Object.entries(o)[0]
    const x = a[k] instanceof Date ? (a[k] as Date).getTime() : (a[k] as number | string | boolean)
    const y = b[k] instanceof Date ? (b[k] as Date).getTime() : (b[k] as number | string | boolean)
    if (x !== y) return (x < y ? -1 : 1) * (dir === 'asc' ? 1 : -1)
  }
  return 0
}
const pick = (row: Record<string, unknown>, select?: Record<string, boolean>) =>
  select ? Object.fromEntries(Object.keys(select).map(k => [k, row[k]])) : row
;(globalThis as unknown as { prisma: unknown }).prisma = {
  organization: { findUnique: async () => ({ id: ORG }) },
  match: {
    findMany: async (a: { where: Where; orderBy: Order[]; take: number; select: Record<string, boolean> }) =>
      rows.filter(r => fits(r, a.where)).sort(compare(a.orderBy)).slice(0, a.take).map(r => pick(r, a.select)),
  },
  matchDismissal: {
    findMany: async (a: { where: { OR: Array<{ partyId: string; listingId: string }> } }) =>
      a.where.OR.filter(k => k.partyId === DISMISSED.counterpartId && k.listingId === DISMISSED.opportunityId),
  },
  extractedOpportunity: { findMany: async () => [] },
  mojoContact: { findMany: async () => [] },
}

type Page = { matches: Array<{ id: string; seen: boolean }>; counts: { total: number }; nextCursor?: string | null }
async function get(query: string): Promise<{ status: number; body: Page }> {
  const { GET } = await import('../route')
  const res = await GET(new NextRequest(`http://localhost/api/matches${query}`))
  return { status: res.status, body: await res.json() as Page }
}
// The order the list promises, worked out here independently of the route.
const ordered = (filter: (r: Row) => boolean) => rows.filter(r => r.organizationId === ORG && filter(r) && r.id !== DISMISSED.id)
  .sort(compare([{ seen: 'asc' }, { score: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }])).map(r => r.id)

async function walk(base: string) {
  const ids: string[] = []
  const sizes: number[] = []
  let after: string | null | undefined = null
  for (let i = 0; i < 10; i++) {
    const { status, body } = await get(`?${base}${after ? `${base ? '&' : ''}after=${encodeURIComponent(after)}` : ''}`)
    assert.equal(status, 200)
    ids.push(...body.matches.map(m => m.id))
    sizes.push(body.matches.length)
    after = body.nextCursor
    if (!after) break
  }
  return { ids, sizes, last: after }
}

test('the list pages past 200: every match once, in order, then nextCursor is null', async () => {
  const { ids, sizes, last } = await walk('')
  assert.deepEqual(ids, ordered(() => true))
  assert.equal(ids.length, 449) // 450, less the dismissed one
  assert.deepEqual(sizes, [200, 199, 50]) // the dismissed pair sits on page 2
  assert.equal(last, null)
})

test('paging keeps the tab and the seen filter', async () => {
  const hot = await walk('scoreMin=90')
  assert.deepEqual(hot.ids, ordered(r => r.score >= 90))
  const unseen = await walk('unseen=1&scoreMin=80')
  assert.deepEqual(unseen.ids, ordered(r => !r.seen && r.score >= 80))
  assert.ok(unseen.ids.length > 200)
})

test('a cursor that is not one of ours is refused with a plain message', async () => {
  const { status, body } = await get('?after=nonsense')
  assert.equal(status, 400)
  assert.match((body as unknown as { error: string }).error, /^That page of matches/)
})
