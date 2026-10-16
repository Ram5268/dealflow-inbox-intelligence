// Brief 41.1 (PR H) — where a production data script writes its pre-image:
// a private JSON file outside every git checkout, written once, owner-only.
// File system only (temporary folders, removed afterwards): no DB, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PrivateDirRefusal, assertPrivateDir, defaultPrivateDir, gitCheckoutOf, privateDirFrom, privateFileName, writePrivateJson,
} from '../privateRecord'

const ROOT = join(__dirname, '..', '..') // this checkout

function withTemp(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'privaterecord-test-'))
  try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('the default folder is ~/dev/brief41-1/private, built from the home directory; --preimage-dir picks another', () => {
  assert.equal(defaultPrivateDir('/Users/someone'), '/Users/someone/dev/brief41-1/private')
  assert.equal(privateDirFrom(['node', 'x.ts', '--apply'], '/work', '/Users/someone'), '/Users/someone/dev/brief41-1/private')
  assert.equal(privateDirFrom(['node', 'x.ts', '--preimage-dir', 'out'], '/work', '/Users/someone'), '/work/out')
  assert.equal(privateDirFrom(['--preimage-dir', '/abs/dir'], '/work', '/h'), '/abs/dir')
  assert.throws(() => privateDirFrom(['--preimage-dir'], '/work', '/h'), PrivateDirRefusal)
  assert.throws(() => privateDirFrom(['--preimage-dir', '--apply'], '/work', '/h'), PrivateDirRefusal)
})

test('refuses a folder inside this repo, or inside any git checkout', () => {
  assert.equal(gitCheckoutOf(join(ROOT, 'lib')), gitCheckoutOf(ROOT))
  assert.ok(gitCheckoutOf(ROOT))
  for (const inside of [ROOT, join(ROOT, 'private'), join(ROOT, 'scripts', 'out', 'new')]) {
    assert.throws(() => assertPrivateDir(inside, ROOT), PrivateDirRefusal, inside)
  }
  withTemp((tmp) => {
    // Another checkout (a worktree has a .git file).
    const other = join(tmp, 'other-repo')
    mkdirSync(other)
    writeFileSync(join(other, '.git'), 'gitdir: /somewhere\n')
    assert.throws(() => assertPrivateDir(join(other, 'private', 'deep'), ROOT), /inside the git checkout/)
    // The repo passed in, even without a .git (a copy).
    const copy = join(tmp, 'repo-copy')
    mkdirSync(copy)
    assert.throws(() => assertPrivateDir(join(copy, 'out'), copy), /inside the repo/)
    // A symlink that points into a checkout.
    symlinkSync(other, join(tmp, 'link'))
    assert.throws(() => assertPrivateDir(join(tmp, 'link', 'private'), ROOT), /inside the git checkout/)
    // Outside every checkout: fine, even before it exists.
    assert.doesNotThrow(() => assertPrivateDir(join(tmp, 'private', 'not-yet'), ROOT))
  })
})

test('writes the JSON once, owner-only, in an owner-only folder it creates', () => {
  withTemp((tmp) => {
    const dir = join(tmp, 'private')
    const name = privateFileName('brief41-test', new Date('2026-10-11T18:42:00.123Z'))
    assert.equal(name, 'brief41-test-2026-10-11T18-42-00-123Z.json')
    const file = writePrivateJson(dir, ROOT, name, { rows: [{ id: 'a', old: 'stale' }] })
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { rows: [{ id: 'a', old: 'stale' }] })
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(statSync(dir).mode & 0o077, 0)
    // Never overwrites an earlier pre-image.
    assert.throws(() => writePrivateJson(dir, ROOT, name, {}), /EEXIST/)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { rows: [{ id: 'a', old: 'stale' }] })
    // A name can't climb out of the folder, and the folder can't be in the repo.
    assert.throws(() => writePrivateJson(dir, ROOT, '../escape.json', {}), PrivateDirRefusal)
    assert.throws(() => writePrivateJson(join(ROOT, 'private'), ROOT, 'x.json', {}), PrivateDirRefusal)
  })
})

test('an existing folder that others can read is made owner-only before the file is written', () => {
  withTemp((tmp) => {
    const dir = join(tmp, 'private')
    mkdirSync(dir)
    chmodSync(dir, 0o755) // mkdir's mode only applies to a folder it creates
    assert.equal(statSync(dir).mode & 0o777, 0o755)
    const file = writePrivateJson(dir, ROOT, 'pre.json', { rows: [] })
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(statSync(file).mode & 0o777, 0o600)
  })
})
