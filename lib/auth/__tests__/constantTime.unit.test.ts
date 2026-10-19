import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import { checkCronBearer } from '../cronBearer'
import { adminSecretOk } from '../../config/maintenance'

// Brief 48 (PR 6, item 4.17): the cron key check and the ADMIN_SECRET check
// must not reveal the key's length [engineering precaution, from the Brief 46
// checkup]. They used to compare lengths first and return early when the
// lengths differed, so only a guess of the right length reached the
// constant-time compare, and the timing showed the length. Now every guess,
// whatever its length, takes the same path: both sides hashed with SHA-256,
// then one crypto.timingSafeEqual on two 32-byte digests. Made-up keys only.

const SECRET = 's3cret-value'

// Runs fn with crypto.createHash and crypto.timingSafeEqual wrapped (the real
// ones still run, as in lib/importScoring/__tests__/request.test.ts) and
// returns what they were asked to do.
function watchCrypto<T>(fn: () => T): { result: T; hashed: string[]; compared: number[][] } {
  const c = crypto as { createHash: typeof crypto.createHash; timingSafeEqual: typeof crypto.timingSafeEqual }
  const realHash = c.createHash
  const realEqual = c.timingSafeEqual
  const hashed: string[] = []
  const compared: number[][] = []
  c.createHash = (algorithm, options) => { hashed.push(algorithm); return realHash(algorithm, options) }
  c.timingSafeEqual = (a, b) => { compared.push([a.byteLength, b.byteLength]); return realEqual(a, b) }
  try {
    return { result: fn(), hashed, compared }
  } finally {
    c.createHash = realHash
    c.timingSafeEqual = realEqual
  }
}

type Key = [label: string, key: string | null]

function sameKeyPathTests<R>(name: string, right: string, run: (key: string | null) => R, yes: R, no: R, extra: Key[] = []) {
  const wrong: Key[] = [
    ['a wrong key of the right length', right.slice(0, -1) + 'X'],
    ['a key one character short', right.slice(0, -1)],
    ['a key one character long', right + '!'],
    ['a key with as many characters but one more byte', right.slice(0, -1) + 'é'],
    ['an empty key', ''],
    ['a 4,096-character key', 'x'.repeat(4096)],
    ...extra,
  ]
  const all: Key[] = [['the right key', right], ...wrong]

  test(`${name}: a key of the wrong length still reaches the constant-time compare, exactly once`, () => {
    for (const [label, key] of all) {
      assert.equal(watchCrypto(() => run(key)).compared.length, 1, `${label}: crypto.timingSafeEqual calls`)
    }
  })

  test(`${name}: every key takes the same path, two SHA-256 hashes then one compare of two 32-byte digests`, () => {
    for (const [label, key] of all) {
      const { hashed, compared } = watchCrypto(() => run(key))
      assert.deepEqual({ hashed, compared }, { hashed: ['sha256', 'sha256'], compared: [[32, 32]] }, label)
    }
  })

  test(`${name}: only the exact key gets through`, () => {
    assert.equal(run(right), yes)
    for (const [label, key] of wrong) assert.equal(run(key), no, label)
  })
}

sameKeyPathTests('checkCronBearer', `Bearer ${SECRET}`, key => checkCronBearer(key, SECRET), 200, 401, [['no Authorization header', null]])
sameKeyPathTests('adminSecretOk', SECRET, key => adminSecretOk(key, SECRET), true, false)
