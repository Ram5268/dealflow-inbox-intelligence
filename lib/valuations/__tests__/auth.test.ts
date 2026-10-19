import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { checkServiceKey, SERVICE_KEY_ID } from '../auth'
import { makeFakeDb, type FakeDb } from './fakeDb'

// Brief 44 §5: the valuation job's key is checked against the SHA-256 fingerprint in
// ServiceKey 'valuation-import'; anything missing or malformed fails closed. No
// database: an in-memory stand-in. The keys here are invented test values.

const KEY = 'test-key-0123456789abcdef0123456789abcdef'
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const asPrisma = (db: FakeDb) => db as unknown as PrismaClient

function withRow(sha: string | null) {
  const db = makeFakeDb()
  if (sha !== null) db.serviceKey.rows.push({ id: SERVICE_KEY_ID, sha256: sha, createdAt: new Date(), rotatedAt: null })
  return db
}
const check = (db: FakeDb, authorization: string | null) => checkServiceKey(asPrisma(db), authorization)

test('the right key passes', async () => {
  assert.equal(await check(withRow(sha256(KEY)), `Bearer ${KEY}`), 200)
  const longest = 'k'.repeat(256)
  assert.equal(await check(withRow(sha256(longest)), `Bearer ${longest}`), 200)
  const shortest = 'k'.repeat(32)
  assert.equal(await check(withRow(sha256(shortest)), `Bearer ${shortest}`), 200)
  const allChars = 'AZaz09._~+/=-'.repeat(3)
  assert.equal(await check(withRow(sha256(allChars)), `Bearer ${allChars}`), 200)
})

test('no ServiceKey row, a malformed fingerprint or a database error fails closed (503)', async () => {
  assert.equal(await check(withRow(null), `Bearer ${KEY}`), 503, 'no row')
  for (const bad of [sha256(KEY).toUpperCase(), sha256(KEY).slice(1), `${sha256(KEY)}0`, 'z'.repeat(64), '', ` ${sha256(KEY).slice(1)}`, KEY]) {
    assert.equal(await check(withRow(bad), `Bearer ${KEY}`), 503, `stored ${JSON.stringify(bad)}`)
  }
  const other = makeFakeDb()
  other.serviceKey.rows.push({ id: 'another-key', sha256: sha256(KEY) })
  assert.equal(await check(other, `Bearer ${KEY}`), 503, 'only the valuation-import row counts')
  const broken = withRow(sha256(KEY))
  broken.serviceKey.findUnique = async () => {
    throw new Error('connection refused')
  }
  assert.equal(await check(broken, `Bearer ${KEY}`), 503, 'database error')
})

test('a wrong, missing, lowercase, raw, short or padded token is refused (401)', async () => {
  const db = withRow(sha256(KEY))
  for (const auth of [
    null, '', 'Bearer', 'Bearer ', `Bearer ${KEY}x`, `Bearer ${KEY.slice(0, -1)}`, KEY, `bearer ${KEY}`, `BEARER ${KEY}`,
    `Bearer  ${KEY}`, `Bearer ${KEY} `, ` Bearer ${KEY}`, `Bearer ${KEY}\n`, `Basic ${KEY}`, `Bearer ${KEY}, Bearer ${KEY}`,
    `Bearer ${KEY.replace('-', ':')}`, `Bearer ${KEY}é`, 'Bearer undefined', 'Bearer null',
  ]) {
    assert.equal(await check(db, auth), 401, JSON.stringify(auth))
  }
})

test('a token outside 32-256 key characters is refused even when its fingerprint is the stored one', async () => {
  for (const token of ['k'.repeat(31), 'k'.repeat(257), 'has space in the middle of it 0123456789', 'tab\tseparated-0123456789abcdef0123456789']) {
    assert.equal(await check(withRow(sha256(token)), `Bearer ${token}`), 401, JSON.stringify(token))
  }
})

test('a malformed header is refused without a database lookup', async () => {
  const db = withRow(sha256(KEY))
  let lookups = 0
  const real = db.serviceKey.findUnique
  db.serviceKey.findUnique = async a => {
    lookups++
    return real(a)
  }
  await check(db, KEY)
  await check(db, `bearer ${KEY}`)
  await check(db, null)
  assert.equal(lookups, 0)
  assert.equal(await check(db, `Bearer ${KEY}`), 200)
  assert.equal(lookups, 1)
})
