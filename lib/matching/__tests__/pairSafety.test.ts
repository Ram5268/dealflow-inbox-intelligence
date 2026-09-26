import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PrismaClient } from '@prisma/client'
import { MIXED_TEST_PAIR, isMixedTestPair, matchSides } from '../pairSafety'

// Brief 35: draft-outreach and schedule-showing return 409 mixed_test_pair when
// one side is test data and the other is a real contact.
const realContact = { kind: 'contact' as const, isTestData: false }
const testContact = { kind: 'contact' as const, isTestData: true }
const realOpp = { kind: 'opportunity' as const, isTestData: false }
const testOpp = { kind: 'opportunity' as const, isTestData: true }

test('test data paired with a real contact is blocked, either way round', () => {
  assert.equal(isMixedTestPair(realContact, testOpp), true) // CRM seller × test ISO buyer
  assert.equal(isMixedTestPair(realContact, testContact), true) // CRM seller × test Mojo buyer
  assert.equal(isMixedTestPair(testOpp, realContact), true)
})

test('all-test, all-real and missing sides are allowed', () => {
  assert.equal(isMixedTestPair(testContact, testOpp), false)
  assert.equal(isMixedTestPair(realContact, realOpp), false)
  assert.equal(isMixedTestPair(realOpp, testOpp), false) // no real contact involved
  assert.equal(isMixedTestPair(realContact, null), false) // e.g. showing_confirmation
  assert.equal(MIXED_TEST_PAIR.reason, 'mixed_test_pair')
})

test('matchSides reads each side from the right table', async () => {
  const flags: Record<string, boolean> = { seller: false, iso: true, buyer: true }
  const db = {
    mojoContact: { findUnique: async ({ where }: { where: { id: string } }) => (where.id in flags && where.id !== 'iso' ? { isTestData: flags[where.id] } : null) },
    extractedOpportunity: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === 'iso' ? { isTestData: true } : null) },
  } as unknown as Pick<PrismaClient, 'mojoContact' | 'extractedOpportunity'>
  const iso = await matchSides(db, { opportunityId: 'seller', opportunityType: 'contact', counterpartId: 'iso', counterpartType: 'opportunity' })
  assert.deepEqual(iso, [realContact, testOpp])
  assert.equal(isMixedTestPair(iso[0], iso[1]), true)
  const mojo = await matchSides(db, { opportunityId: 'seller', opportunityType: 'contact', counterpartId: 'buyer', counterpartType: 'mojo' })
  assert.deepEqual(mojo, [realContact, testContact])
  const showing = await matchSides(db, { opportunityId: 'iso', opportunityType: 'opportunity', counterpartId: 'iso', counterpartType: 'showing_confirmation' })
  assert.deepEqual(showing, [testOpp, null])
})
