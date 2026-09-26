import type { PrismaClient } from '@prisma/client'

// Brief 35: a match that pairs test data with a real contact must never produce
// outreach or a calendar event. A draft to a test buyer would quote a real
// homeowner's address. draft-outreach and schedule-showing return 409 with this body.
export const MIXED_TEST_PAIR = {
  reason: 'mixed_test_pair',
  error: 'This match pairs test data with a real homeowner, so drafting and scheduling are blocked.',
} as const

type Side = { kind: 'contact' | 'opportunity'; isTestData: boolean }

export function isMixedTestPair(a: Side | null, b: Side | null): boolean {
  if (!a || !b) return false
  const realContact = (s: Side) => s.kind === 'contact' && !s.isTestData
  return (a.isTestData && realContact(b)) || (b.isTestData && realContact(a))
}

export async function matchSides(
  db: Pick<PrismaClient, 'mojoContact' | 'extractedOpportunity'>,
  m: { opportunityId: string; opportunityType: string; counterpartId: string; counterpartType: string },
): Promise<[Side | null, Side | null]> {
  const side = async (id: string, kind: Side['kind']): Promise<Side | null> => {
    const row = kind === 'contact'
      ? await db.mojoContact.findUnique({ where: { id }, select: { isTestData: true } })
      : await db.extractedOpportunity.findUnique({ where: { id }, select: { isTestData: true } })
    return row ? { kind, isTestData: row.isTestData } : null
  }
  const counterpartKind = m.counterpartType === 'mojo' ? 'contact' : m.counterpartType === 'opportunity' ? 'opportunity' : null
  return Promise.all([
    side(m.opportunityId, m.opportunityType === 'contact' ? 'contact' : 'opportunity'),
    counterpartKind ? side(m.counterpartId, counterpartKind) : Promise.resolve(null),
  ])
}
