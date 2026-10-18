import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { checkServiceKey, sha256Hex, SERVICE_KEY_ID } from '../auth'
import { KEY_REFUSED, keyFromStdin, storeServiceKey } from '../serviceKey'
import { makeFakeDb, type FakeDb } from './fakeDb'

// Brief 44 data step V2 (scripts/valuation-service-key.ts): it stores only the
// SHA-256 fingerprint of the import key, reads the key from stdin only, and never
// prints the key or the fingerprint. No database: an in-memory stand-in, and the
// script itself is run only on paths that stop before any database use. The keys
// here are invented test values.

const ROOT = join(__dirname, '..', '..', '..')
const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90' // shaped like `openssl rand -hex 32`
const FP = createHash('sha256').update(KEY, 'utf8').digest('hex')
const asPrisma = (db: FakeDb) => db as unknown as PrismaClient
const WRITES = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'deleteMany'])

// Nothing printed may hold the key, the fingerprint, or any 12-character piece of either.
function assertNoEcho(text: string) {
  for (const secret of [KEY, FP]) {
    for (let i = 0; i + 12 <= secret.length; i++) assert.ok(!text.includes(secret.slice(i, i + 12)), `printed part of a secret: ${text}`)
  }
}

test('the key comes from stdin with at most one trailing newline, and must be 32-256 key characters', () => {
  assert.equal(keyFromStdin(KEY), KEY)
  assert.equal(keyFromStdin(`${KEY}\n`), KEY, 'echo adds a newline')
  assert.equal(keyFromStdin('k'.repeat(32)), 'k'.repeat(32))
  assert.equal(keyFromStdin('k'.repeat(256)), 'k'.repeat(256))
  for (const raw of [
    `${KEY}\n\n`, `${KEY}\r\n`, `\n${KEY}`, ` ${KEY}`, `${KEY} `, 'k'.repeat(31), 'k'.repeat(257), '', '\n', `${KEY}:`, `${KEY.slice(0, 40)} ${KEY.slice(40)}`,
  ]) {
    assert.equal(keyFromStdin(raw), null, JSON.stringify(raw))
  }
  assert.equal(keyFromStdin(null), null, 'nothing piped in (a terminal, or too much input)')
  assertNoEcho(KEY_REFUSED)
})

test('the fingerprint is the lowercase hex SHA-256 of the key', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(sha256Hex(KEY), FP)
  assert.match(FP, /^[0-9a-f]{64}$/)
})

test('a dry run writes nothing and says only whether it would create or rotate', async () => {
  const empty = makeFakeDb()
  const create = await storeServiceKey(asPrisma(empty), KEY, false)
  assert.equal(create.exitCode, 0)
  assert.match(create.message, /would create/)
  assert.equal(empty.serviceKey.rows.length, 0)
  assert.ok(!empty.ops.some(o => WRITES.has(o.method)), 'no write call')
  assertNoEcho(create.message)

  const existing = makeFakeDb()
  existing.serviceKey.rows.push({ id: SERVICE_KEY_ID, sha256: 'f'.repeat(64), createdAt: new Date('2026-10-01T00:00:00Z'), rotatedAt: null })
  const rotate = await storeServiceKey(asPrisma(existing), KEY, false)
  assert.equal(rotate.exitCode, 0)
  assert.match(rotate.message, /would rotate/)
  assert.equal(existing.serviceKey.rows[0].sha256, 'f'.repeat(64))
  assert.equal(existing.serviceKey.rows[0].rotatedAt, null)
  assert.ok(!existing.ops.some(o => WRITES.has(o.method)))
  assertNoEcho(rotate.message)
})

test('--apply creates the row, or rotates it (new fingerprint, rotatedAt now); the key then opens the protected addresses', async () => {
  const db = makeFakeDb()
  const created = await storeServiceKey(asPrisma(db), KEY, true)
  assert.equal(created.exitCode, 0)
  assert.match(created.message, /^Created/)
  assertNoEcho(created.message)
  assert.equal(db.serviceKey.rows.length, 1)
  assert.equal(db.serviceKey.rows[0].id, SERVICE_KEY_ID)
  assert.equal(db.serviceKey.rows[0].sha256, FP)
  assert.equal(db.serviceKey.rows[0].rotatedAt, null)
  assert.ok(!JSON.stringify(db.serviceKey.rows).includes(KEY), 'the key itself is never stored')
  assert.equal(await checkServiceKey(asPrisma(db), `Bearer ${KEY}`), 200)

  const NEXT = 'b'.repeat(64)
  const at = new Date('2026-11-01T12:00:00Z')
  const createdAt = db.serviceKey.rows[0].createdAt
  const rotated = await storeServiceKey(asPrisma(db), NEXT, true, at)
  assert.equal(rotated.exitCode, 0)
  assert.match(rotated.message, /^Rotated/)
  assert.ok(!rotated.message.includes(NEXT.slice(0, 12)) && !rotated.message.includes(sha256Hex(NEXT).slice(0, 12)))
  assert.equal(db.serviceKey.rows.length, 1)
  const after = { ...db.serviceKey.rows[0] }
  assert.equal(after.sha256, sha256Hex(NEXT))
  assert.equal((after.rotatedAt as Date).toISOString(), at.toISOString())
  assert.equal(after.createdAt, createdAt)
  assert.equal(await checkServiceKey(asPrisma(db), `Bearer ${NEXT}`), 200)
  assert.equal(await checkServiceKey(asPrisma(db), `Bearer ${KEY}`), 401, 'the old key stops working')
})

test('a database error prints neither the key nor the fingerprint, even when the error message holds them', async () => {
  for (const method of ['findUnique', 'upsert'] as const) {
    for (const apply of [false, true]) {
      const db = makeFakeDb()
      db.serviceKey[method] = async () => {
        throw Object.assign(new Error(`failed for ${KEY} with sha256 ${FP}`), { code: 'P1001' })
      }
      const out = await storeServiceKey(asPrisma(db), KEY, apply)
      if (method === 'upsert' && !apply) {
        assert.equal(out.exitCode, 0, 'a dry run never writes, so never fails there')
        continue
      }
      assert.equal(out.exitCode, 1, `${method} apply=${apply}`)
      assert.match(out.message, /P1001/)
      assertNoEcho(out.message)
    }
  }
})

// The script itself, with no database configured: only the paths that stop before
// any database use.
function runScript(args: string[], input: string, extraEnv: Record<string, string> = {}) {
  const env = { ...extraEnv, NODE_ENV: 'test' as const, PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR ?? '' }
  const r = spawnSync(process.execPath, [...process.execArgv, 'scripts/valuation-service-key.ts', ...args], {
    cwd: ROOT, input, env, encoding: 'utf8', timeout: 60_000,
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

test('the script reads the key from stdin only and never prints what it was given', () => {
  const bad = runScript([], 'not a key at all: Zq secret Zq\n')
  assert.equal(bad.code, 2, bad.out)
  assert.ok(bad.out.includes(KEY_REFUSED), bad.out)
  assert.ok(!bad.out.includes('Zq secret Zq'))

  const argv = runScript([KEY], '')
  assert.equal(argv.code, 2, 'a key on the command line is ignored')
  assertNoEcho(argv.out)

  const env = runScript([], '', { VALUATION_IMPORT_SECRET: KEY, SERVICE_KEY: KEY })
  assert.equal(env.code, 2, 'a key in the environment is ignored')
  assertNoEcho(env.out)

  // --apply with no database it can name is refused by the guard before the key is read.
  const apply = runScript(['--apply'], `${KEY}\n`)
  assert.notEqual(apply.code, 0)
  assert.match(apply.out, /REFUSING/)
  assertNoEcho(apply.out)
})
