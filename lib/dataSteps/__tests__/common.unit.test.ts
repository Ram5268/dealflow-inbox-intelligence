// Brief 48 (data steps): the shared flags, the --expect rule, and the private
// before-copy (written owner-only, read back only for its own step and database).
// File system only (temporary folders, removed afterwards): no DB, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BEFORE_COPY_FORMAT, DataStepRefusal, assertExpect, beforeCopyDirFrom, defaultBeforeCopyDir, emptyBeforeCopy, flagValue,
  parseExpect, parseMode, readBeforeCopy, safeErrorLine, someIds, writeBeforeCopy,
} from '../common'

const ROOT = join(__dirname, '..', '..', '..') // this checkout

function withTemp(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'b48-ds-common-'))
  try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('--expect takes a whole number; a flag with no value is refused', () => {
  assert.equal(parseExpect(['node', 'x.ts']), null)
  assert.equal(parseExpect(['node', 'x.ts', '--apply', '--expect', '1497']), 1497)
  assert.throws(() => parseExpect(['--expect']), DataStepRefusal)
  assert.throws(() => parseExpect(['--expect', '--apply']), DataStepRefusal)
  assert.throws(() => parseExpect(['--expect', '12abc']), /whole number/)
  assert.throws(() => parseExpect(['--expect', '-3']), DataStepRefusal)
  assert.equal(flagValue(['--restore', 'f.json'], '--restore'), 'f.json')
})

test('--apply must name exactly the count the dry run printed', () => {
  assert.throws(() => assertExpect(null, 3, 'rows'), /needs --expect <n>.*would write 3 rows/)
  assert.throws(() => assertExpect(4, 3, 'rows'), /would write 3 rows, but --expect says 4/)
  assert.throws(() => assertExpect(0, 3, 'rows'), DataStepRefusal)
  assert.doesNotThrow(() => assertExpect(3, 3, 'rows'))
})

test('modes: the plan, --check <file> (read-only, never with --apply) or --restore <file>, not both', () => {
  assert.deepEqual(parseMode(['node', 'x.ts', '--apply', '--expect', '3']), { kind: 'plan' })
  assert.deepEqual(parseMode(['--check', 'a.json'], '/work'), { kind: 'check', file: '/work/a.json' })
  assert.deepEqual(parseMode(['--restore', '/abs/a.json', '--apply'], '/work'), { kind: 'restore', file: '/abs/a.json' })
  assert.throws(() => parseMode(['--check', 'a', '--restore', 'b']), /not both/)
  assert.throws(() => parseMode(['--check', 'a', '--apply']), /only reads/)
  assert.throws(() => parseMode(['--restore']), DataStepRefusal)
})

test('the before-copy folder is ~/dev/brief48-dealflow-fixes/private unless --preimage-dir', () => {
  assert.equal(defaultBeforeCopyDir('/Users/someone'), '/Users/someone/dev/brief48-dealflow-fixes/private')
  assert.equal(beforeCopyDirFrom(['--apply'], '/work', '/Users/someone'), '/Users/someone/dev/brief48-dealflow-fixes/private')
  assert.equal(beforeCopyDirFrom(['--preimage-dir', 'out'], '/work', '/h'), '/work/out')
})

test('a before-copy is written once, owner-only, and read back only for its own step and database', () => {
  withTemp(tmp => {
    const dir = join(tmp, 'private')
    const now = new Date('2026-10-23T12:00:00.000Z')
    const copy = emptyBeforeCopy('DS-1', 'b48_x_test', 'org-1', now)
    copy.expect = 2
    const file = writeBeforeCopy(dir, ROOT, copy, now)
    assert.match(file, /brief48-ds-1-2026-10-23T12-00-00-000Z\.json$/)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.throws(() => writeBeforeCopy(dir, ROOT, copy, now), /EEXIST|exists/) // never overwritten
    const back = readBeforeCopy(file, 'DS-1', 'b48_x_test')
    assert.equal(back.format, BEFORE_COPY_FORMAT)
    assert.equal(back.expect, 2)
    assert.throws(() => readBeforeCopy(file, 'DS-3', 'b48_x_test'), /before-copy of DS-1, not DS-3/)
    assert.throws(() => readBeforeCopy(file, 'DS-1', 'railway'), /made on database "b48_x_test", not "railway"/)
    assert.throws(() => readBeforeCopy(file, 'DS-1', null), DataStepRefusal)
    chmodSync(file, 0o644)
    assert.throws(() => readBeforeCopy(file, 'DS-1', 'b48_x_test'), /others can read/)
    const junk = join(dir, 'junk.json')
    writeFileSync(junk, 'not json', { mode: 0o600 })
    assert.throws(() => readBeforeCopy(junk, 'DS-1', 'b48_x_test'), /not JSON/)
    const other = join(dir, 'other.json')
    writeFileSync(other, JSON.stringify({ format: 'something-else', step: 'DS-1' }), { mode: 0o600 })
    assert.throws(() => readBeforeCopy(other, 'DS-1', 'b48_x_test'), /isn't a Brief 48 before-copy/)
    assert.throws(() => readBeforeCopy(join(dir, 'missing.json'), 'DS-1', 'b48_x_test'), /can't read/)
  })
})

test('a before-copy folder inside this repo is refused', () => {
  const copy = emptyBeforeCopy('DS-2', 'b48_x_test', 'org-1', new Date())
  assert.throws(() => writeBeforeCopy(join(ROOT, 'private'), ROOT, copy, new Date()), /inside the repo/)
})

test('error lines: our refusals as they are; a database message with its values hidden', () => {
  assert.equal(safeErrorLine(new DataStepRefusal('Refusing: x. Nothing changed.')), 'Refusing: x. Nothing changed.')
  const pg = Object.assign(new Error('null value violates not-null constraint. Failing row contains (c1, Pat Example, 88 Example Ave).\nDETAIL: more'), { code: '23502' })
  const line = safeErrorLine(pg)
  assert.match(line, /^Failed \(Error 23502\)/)
  assert.doesNotMatch(line, /Pat Example|88 Example Ave/)
  assert.doesNotMatch(safeErrorLine(new Error('invalid input syntax for type integer: "Jordan Sample"')), /Jordan Sample/)
})

test('someIds shows at most n ids', () => {
  assert.deepEqual(someIds(['a', 'b']), ['a', 'b'])
  assert.deepEqual(someIds(['a', 'b', 'c'], 2), ['a', 'b', '… and 1 more'])
})
