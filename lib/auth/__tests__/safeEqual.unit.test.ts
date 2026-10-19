import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import { safeEqual } from '../safeEqual'

// Brief 48 (PR 6, item 4.17): the shared constant-time compare behind
// checkCronBearer and adminSecretOk [engineering precaution]. Made-up keys only.

test('true only for exactly the same text', () => {
  assert.equal(safeEqual('s3cret-value', 's3cret-value'), true)
  assert.equal(safeEqual('ü-ñ-秘密', 'ü-ñ-秘密'), true)
  for (const other of ['s3cret-valuX', 's3cret-valu', 's3cret-value!', 'S3cret-value', ' s3cret-value', 's3cret-value ', 's3cret-value\n', '']) {
    assert.equal(safeEqual(other, 's3cret-value'), false, JSON.stringify(other))
    assert.equal(safeEqual('s3cret-value', other), false, JSON.stringify(other))
  }
  // Bytes, not letters: the same word written two ways in Unicode doesn't match.
  assert.equal(safeEqual('café', 'café'), false)
})

test('an empty key equals only an empty key, so callers refuse an unset or empty secret before comparing', () => {
  assert.equal(safeEqual('', ''), true)
  assert.equal(safeEqual('', 'x'), false)
  assert.equal(safeEqual('x', ''), false)
})

test('keys of any length are compared without throwing, always as two 32-byte digests', () => {
  const real = crypto.timingSafeEqual
  const seen: number[][] = []
  ;(crypto as { timingSafeEqual: typeof real }).timingSafeEqual = (a, b) => { seen.push([a.byteLength, b.byteLength]); return real(a, b) }
  const keys = ['', 'B', 's3cret-valu', 's3cret-value', 's3cret-value!', 'x'.repeat(4096), '秘'.repeat(1000)]
  try {
    for (const key of keys) assert.doesNotThrow(() => safeEqual(key, 's3cret-value'), `${key.length} characters`)
  } finally {
    ;(crypto as { timingSafeEqual: typeof real }).timingSafeEqual = real
  }
  assert.deepEqual(seen, keys.map(() => [32, 32]))
})
