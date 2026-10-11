// Brief 41.1 (PR H) — the sweep's date rules live in lib/dateExpiryRules.ts,
// shared by sweepDateExpirations and the miss-delisting repair. This runs the
// real sweep on an in-memory stand-in for Prisma (set on globalThis before
// lib/prisma loads, so no client is created and nothing connects) and checks
// that it does exactly what dateExpiryFor says, row by row. The date sweep
// makes no requests; fetch is made to throw so a change that added one would
// fail here instead of reaching the network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dateExpiryCutoffs, dateExpiryFor } from '../dateExpiryRules'

type Row = { id: string; category: string; processingStatus: string; availabilityDate: string | null; streetEasyCheckedAt: Date | null; createdAt: Date }
type Filter = Record<string, unknown>

// Just the where-clause shapes the sweep uses: equality, null, { in }, { not: null, lt }.
function matches(row: Row, where: Filter): boolean {
  return Object.entries(where).every(([key, want]) => {
    const have = row[key as keyof Row]
    if (want === null) return have === null
    if (typeof want !== 'object' || want instanceof Date) return have === want
    const f = want as { in?: unknown[]; not?: null; lt?: string | Date }
    if (f.in && !f.in.includes(have)) return false
    if ('not' in f && f.not === null && have === null) return false
    if (f.lt !== undefined) {
      if (have === null) return false
      return f.lt instanceof Date ? (have as Date).getTime() < f.lt.getTime() : (have as string) < f.lt
    }
    return true
  })
}

test('the cutoffs: now, 30 days back, 90 days back', () => {
  const cut = dateExpiryCutoffs(new Date('2026-10-11T12:00:00Z'))
  assert.deepEqual(cut, {
    pastEventBefore: '2026-10-11T12:00:00.000Z',
    comingSoonBefore: '2026-09-11T12:00:00.000Z',
    agedBefore: new Date('2026-07-13T12:00:00.000Z'),
  })
})

test('sweepDateExpirations does exactly what dateExpiryFor says', async () => {
  process.env.STREETEASY_SYNC_ENABLED = 'true'
  delete process.env.TEST_MODE_ONLY
  globalThis.fetch = async () => { throw new Error('no network in this test') }
  const day = (d: number) => new Date(Date.now() - d * 86_400_000)
  const isoDay = (d: number) => day(d).toISOString().slice(0, 10)
  const r = (id: string, category: string, over: Partial<Row> = {}): Row =>
    ({ id, category, processingStatus: 'active', availabilityDate: null, streetEasyCheckedAt: day(5), createdAt: day(20), ...over })
  const rows: Row[] = [
    r('ohPast', 'OPEN_HOUSE', { availabilityDate: isoDay(2) }),
    r('ohFuture', 'OPEN_HOUSE', { availabilityDate: isoDay(-2) }),
    r('ohUndated', 'OPEN_HOUSE'),
    r('showPast', 'SHOWING_CONFIRMATION', { availabilityDate: `${isoDay(1)}T10:00` }),
    r('csOld', 'COMING_SOON_SALE', { availabilityDate: isoDay(40) }),
    r('csRecent', 'COMING_SOON_RENTAL', { availabilityDate: isoDay(20) }),
    r('csDevOld', 'COMING_SOON_DEVELOPMENT', { availabilityDate: isoDay(400) }),
    r('saleAged', 'ACTIVE_SALE_LISTING', { createdAt: day(100), streetEasyCheckedAt: null }),
    r('saleAgedChecked', 'ACTIVE_SALE_LISTING', { createdAt: day(100) }),
    r('offAged', 'OFF_MARKET_SALE', { createdAt: day(91), streetEasyCheckedAt: null }),
    r('offYoung', 'OFF_MARKET_SALE', { createdAt: day(80), streetEasyCheckedAt: null }),
    r('buyerAged', 'BUYER_ISO', { createdAt: day(300), streetEasyCheckedAt: null }),
    r('staleOh', 'OPEN_HOUSE', { availabilityDate: isoDay(2), processingStatus: 'stale' }),
  ]
  const written = new Map<string, unknown>()
  ;(globalThis as unknown as { prisma: unknown }).prisma = {
    extractedOpportunity: {
      findMany: async ({ where }: { where: Filter }) => rows.filter((row) => matches(row, where)).map((row) => ({ id: row.id })),
      update: async ({ where, data }: { where: { id: string }; data: { processingStatus: string } }) => {
        written.set(where.id, data.processingStatus)
        return {}
      },
    },
  }
  const now = new Date()
  const { sweepDateExpirations } = await import('../streetEasySync')
  const count = await sweepDateExpirations()
  const expected = Object.fromEntries(
    rows.filter((row) => row.processingStatus === 'active')
      .map((row) => [row.id, dateExpiryFor(row, now)])
      .filter(([, status]) => status !== null),
  )
  assert.deepEqual(Object.fromEntries(written), expected)
  assert.deepEqual(expected, { ohPast: 'stale', showPast: 'stale', csOld: 'stale', saleAged: 'needs_review', offAged: 'needs_review' })
  assert.equal(count, 5)
})
