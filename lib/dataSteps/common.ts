// Brief 48 (data steps DS-1 to DS-3): the pieces the three data-step scripts
// share (scripts/brief48-ds1-remove-duplicates.ts, scripts/brief48-ds2-add-test-buyers.ts,
// scripts/brief48-ds3-remove-old-matches.ts). The steps are Ryan's, pre-approved
// on 2026-10-19 (BRIEF_48.md §4); how they run is an engineering precaution:
//   - a dry run unless --apply (maintenanceApply, lib/dbGuard.ts); on the live
//     database --apply also needs --i-mean-live;
//   - output is counts and ids only, never names, phones, emails or addresses;
//   - --apply needs --expect <n>, the count its dry run printed, or nothing is written;
//   - before the first write, a private before-copy (folder 0700, file 0600, never
//     printed) in ~/dev/brief48-dealflow-fixes/private/ unless --preimage-dir <dir>;
//   - every write happens in one transaction;
//   - a read-only check afterwards (also alone: --check <before-copy>);
//   - --restore <before-copy> undoes a run (a dry run, then --apply --expect <n>).
// Pure helpers here; the database work is in lib/dataSteps/rows.ts.
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { PREIMAGE_DIR_FLAG, PrivateDirRefusal, assertOwnerOnly, assertPrivateDir, makeOwnerOnly, privateFileName } from '../privateRecord'

// A refusal: nothing was written. The scripts print the message and exit 2.
export class DataStepRefusal extends Error {}

export const EXPECT_FLAG = '--expect'
export const CHECK_FLAG = '--check'
export const RESTORE_FLAG = '--restore'
export const PLAN_FLAG = '--plan' // Brief 48 review: the dry run's plan fingerprint (lib/dataSteps/runner.ts)
export const ORG_SLUG = 'dealflow-ryan'
export const BEFORE_COPY_FORMAT = 'brief48-data-step-before-copy/1'

export type StepId = 'DS-1' | 'DS-2' | 'DS-3'

// The value after `flag`, or null when the flag isn't given.
export function flagValue(argv: readonly string[], flag: string): string | null {
  const at = argv.indexOf(flag)
  if (at < 0) return null
  const value = argv[at + 1]
  if (!value || value.startsWith('--')) throw new DataStepRefusal(`Refusing: ${flag} needs a value. Nothing changed.`)
  return value
}

// --expect <n>: the count the dry run printed.
export function parseExpect(argv: readonly string[]): number | null {
  const value = flagValue(argv, EXPECT_FLAG)
  if (value === null) return null
  if (!/^\d+$/.test(value)) throw new DataStepRefusal(`Refusing: ${EXPECT_FLAG} needs a whole number (the dry run's count), got "${value}". Nothing changed.`)
  return Number(value)
}

// --plan <code>: the 12-character fingerprint a dry run printed (optional).
export function parsePlan(argv: readonly string[]): string | null {
  const value = flagValue(argv, PLAN_FLAG)
  if (value === null) return null
  if (!/^[0-9a-f]{12}$/.test(value)) throw new DataStepRefusal(`Refusing: ${PLAN_FLAG} needs the 12-character plan fingerprint the dry run printed, got "${value}". Nothing changed.`)
  return value
}

export type Mode = { kind: 'plan' } | { kind: 'check'; file: string } | { kind: 'restore'; file: string }

// The plan (dry run or --apply), --check <file> (read-only), or --restore <file>.
export function parseMode(argv: readonly string[], cwd: string = process.cwd()): Mode {
  const check = flagValue(argv, CHECK_FLAG)
  const restore = flagValue(argv, RESTORE_FLAG)
  if (check && restore) throw new DataStepRefusal(`Refusing: give ${CHECK_FLAG} or ${RESTORE_FLAG}, not both. Nothing changed.`)
  if (check) {
    if (argv.includes('--apply')) throw new DataStepRefusal(`Refusing: ${CHECK_FLAG} only reads; leave out --apply. Nothing changed.`)
    return { kind: 'check', file: resolve(cwd, check) }
  }
  if (restore) return { kind: 'restore', file: resolve(cwd, restore) }
  return { kind: 'plan' }
}

// --apply must name the count the dry run printed.
export function assertExpect(expect: number | null, actual: number, what: string): void {
  if (expect === null) {
    throw new DataStepRefusal(`Refusing: --apply needs ${EXPECT_FLAG} <n>, the count the dry run printed (this run would write ${actual} ${what}). Nothing changed.`)
  }
  if (expect !== actual) {
    throw new DataStepRefusal(`Refusing: this run would write ${actual} ${what}, but ${EXPECT_FLAG} says ${expect}. Nothing changed. Re-run the dry run.`)
  }
}

export function defaultBeforeCopyDir(home: string = homedir()): string {
  return join(home, 'dev', 'brief48-dealflow-fixes', 'private')
}

// --preimage-dir <dir> (relative to the current directory), or the default.
export function beforeCopyDirFrom(argv: readonly string[], cwd: string = process.cwd(), home: string = homedir()): string {
  const value = flagValue(argv, PREIMAGE_DIR_FLAG)
  return value === null ? defaultBeforeCopyDir(home) : resolve(cwd, value)
}

// ── The before-copy ─────────────────────────────────────────────────────────
// Every row a run removes or changes, as Postgres's to_jsonb of the whole row,
// so --restore can put it back exactly; and every row it creates, so --restore
// can delete exactly those. Plus counts. It holds homeowners' records, so it
// is private (lib/privateRecord.ts) and never printed.
export type Row = Record<string, unknown> & { id: string }

export interface ChangedRow {
  before: Row // the whole row before the run
  after: Record<string, unknown> // the columns the run set, and their new values
}

export interface BeforeCopy {
  format: typeof BEFORE_COPY_FORMAT
  step: StepId
  createdAt: string
  database: string
  organizationId: string
  expect: number
  counts: Record<string, unknown>
  removed: Record<string, Row[]> // table → rows the run deleted
  changed: Record<string, ChangedRow[]> // table → rows the run updated
  created: Record<string, Row[]> // table → rows the run inserted (as planned)
  // The org's call-list generation ids once the run's writes were done. --restore
  // puts call-list rows back only while this is still the list (the nightly
  // rebuilds it with a new id; restoring rows of an old list would leave stale rows).
  callListGenerations: string[]
  extra: Record<string, unknown> // step-specific (DS-1: the kept records' fingerprints)
}

export function emptyBeforeCopy(step: StepId, database: string, organizationId: string, now: Date): BeforeCopy {
  return {
    format: BEFORE_COPY_FORMAT, step, createdAt: now.toISOString(), database, organizationId,
    expect: 0, counts: {}, removed: {}, changed: {}, created: {}, callListGenerations: [], extra: {},
  }
}

export function beforeCopyName(step: StepId, now: Date): string {
  return privateFileName(`brief48-${step.toLowerCase()}`, now)
}

// Written once (never overwritten), owner-only, outside every git checkout, with
// lib/privateRecord.ts's folder rules (a new folder is made 0700; an existing one
// must already be owner-only).
// Brief 48 review (engineering precaution): atomic. The copy goes to a temporary
// file (0600) in the same folder, is flushed to disk (fsync), and is then given
// its name with a hard link, which fails if the name exists. So the named file is
// either the whole copy or absent, even if the run is killed or the Mac loses
// power mid-write; a half-written copy can never be taken for a whole one.
export function writeBeforeCopy(dir: string, repoRoot: string, copy: BeforeCopy, now: Date): string {
  const name = beforeCopyName(copy.step, now)
  const real = assertPrivateDir(dir, repoRoot)
  if (existsSync(real)) {
    assertOwnerOnly(real)
  } else {
    mkdirSync(real, { recursive: true, mode: 0o700 })
    makeOwnerOnly(real)
  }
  const file = join(real, name)
  if (existsSync(file)) throw new PrivateDirRefusal(`Refusing: ${name} exists already; a before-copy is never overwritten. Nothing changed.`)
  const tmp = join(real, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    try {
      const data = Buffer.from(`${JSON.stringify(copy, null, 2)}\n`, 'utf8')
      for (let at = 0; at < data.length;) at += writeSync(fd, data, at, data.length - at)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    linkSync(tmp, file) // EEXIST if the name was taken meanwhile: never overwritten
  } finally {
    unlinkSync(tmp)
  }
  try { // the folder entry itself, so the name survives a crash too
    const dfd = openSync(real, 'r')
    try { fsyncSync(dfd) } finally { closeSync(dfd) }
  } catch {
    // some file systems can't fsync a folder; the file's own data is already on disk
  }
  return file
}

// Reads a before-copy for `step` on `database`. Refuses a file others can
// read, another step's file, or one made on another database.
export function readBeforeCopy(file: string, step: StepId, database: string | null): BeforeCopy {
  let mode: number
  try {
    mode = statSync(file).mode
  } catch {
    throw new DataStepRefusal(`Refusing: can't read the before-copy ${basename(file)}. Nothing changed.`)
  }
  if ((mode & 0o077) !== 0) throw new DataStepRefusal(`Refusing: others can read ${basename(file)}; a before-copy must be owner-only (chmod 600). Nothing changed.`)
  let copy: BeforeCopy
  try {
    copy = JSON.parse(readFileSync(file, 'utf8')) as BeforeCopy
  } catch {
    throw new DataStepRefusal(`Refusing: ${basename(file)} isn't a before-copy (not JSON). Nothing changed.`)
  }
  if (copy?.format !== BEFORE_COPY_FORMAT) throw new DataStepRefusal(`Refusing: ${basename(file)} isn't a Brief 48 before-copy. Nothing changed.`)
  if (copy.step !== step) throw new DataStepRefusal(`Refusing: ${basename(file)} is the before-copy of ${copy.step}, not ${step}. Nothing changed.`)
  if (!database || copy.database !== database) {
    throw new DataStepRefusal(`Refusing: ${basename(file)} was made on database "${copy.database}", not "${database ?? '(not set)'}". Nothing changed.`)
  }
  return copy
}

// ── Output ──────────────────────────────────────────────────────────────────
// Only DataStepRefusal messages are ours. A database error's message can quote
// row values ("Failing row contains (...)", "Key (...)=(...)"), so anything in
// brackets is hidden.
export function safeErrorLine(e: unknown): string {
  if (e instanceof DataStepRefusal) return e.message
  const err = e as { name?: string; code?: string; message?: string; meta?: { code?: unknown }; constructor?: { name?: string } }
  const name = err?.constructor?.name ?? err?.name ?? 'Error'
  const codes = [err?.code, err?.meta?.code].filter((c): c is string => typeof c === 'string')
  const code = codes.length ? ` ${codes.join(' ')}` : ''
  const message = typeof err?.message === 'string'
    ? err.message.replace(/\([^)]*\)/g, '(…)').replace(/"[^"]*"/g, '"…"').split('\n').map(l => l.trim()).filter(Boolean).join(' ').slice(0, 300)
    : ''
  return `Failed (${name}${code})${message ? `: ${message}` : ''}`
}

// At most `n` ids, for a line that names the rows a refusal is about.
export function someIds(ids: readonly string[], n = 20): string[] {
  return ids.length <= n ? [...ids] : [...ids.slice(0, n), `… and ${ids.length - n} more`]
}

export const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0)
