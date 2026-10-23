// Brief 48 (data steps): the one flow all three data-step scripts follow
// (lib/dataSteps/common.ts lists the rules). Each step supplies its plan, its
// writes and its own after-check; this file does the rest the same way for all.
//   plan mode     dry run (read-only transaction): notices, the summary, the --expect number.
//                 --apply --expect <n>: the same plan again inside the write transaction;
//                 refused if it differs from <n>; the before-copy is written; the writes;
//                 commit; then the read-only after-check.
//   --check       the read-only after-check alone, from a before-copy.
//   --restore     dry run of the restore; with --apply --expect <n>, the restore in one
//                 transaction, then a read-only check that every row is back.
import type { PrismaClient } from '@prisma/client'
import { basename } from 'node:path'
import { PrivateDirRefusal, assertPrivateDir, defaultPrivateDir } from '../privateRecord'
import {
  DataStepRefusal, ORG_SLUG, RESTORE_FLAG, assertExpect, beforeCopyDirFrom, defaultBeforeCopyDir, parseExpect, parseMode, readBeforeCopy,
  someIds, writeBeforeCopy, type BeforeCopy, type StepId,
} from './common'
import { applyRestore, checkApplied, checkRestored, loadRestoreFacts, planRestore, type RestorePlan } from './restore'
import { auditRow, orgIdBySlug, readOnly, writeTransaction, type Tx } from './rows'

export interface PlanResult<P> {
  plan: P
  expect: number // the count --expect must equal
  summary: Record<string, unknown> // printed: counts and ids only
  refusals: string[] // --apply refuses with these
  notices: string[] // printed first
  mentions: Record<string, number> | null
}

export interface Step<P> {
  id: StepId
  title: string
  unit: string // what --expect counts, e.g. "duplicate copies"
  restoreAction: string // the AuditLog action of a restore (each step's apply writes its own)
  // mentions: null = count them now (the dry run); else the dry run's counts.
  plan(tx: Tx, orgId: string, argv: readonly string[], mentions: Record<string, number> | null): Promise<PlanResult<P>>
  newCopy(database: string, orgId: string, now: Date, r: PlanResult<P>): BeforeCopy
  apply(tx: Tx, r: PlanResult<P>, copy: BeforeCopy, save: (c: BeforeCopy) => string): Promise<string>
  check(tx: Tx, copy: BeforeCopy): Promise<{ ok: boolean; counts: Record<string, number> }>
}

export interface RunOptions {
  db: PrismaClient
  argv: readonly string[]
  apply: boolean // maintenanceApply's answer
  database: string | null // databaseName(DATABASE_URL)
  repoRoot: string
  log?: (line: string) => void
  now?: () => Date
}

export const EXIT = { ok: 0, failed: 1, refused: 2, checkFailed: 3 } as const

const show = (o: unknown) => JSON.stringify(o, null, 2)

// Runs one invocation; returns the process exit code.
export async function runStep<P>(step: Step<P>, o: RunOptions): Promise<number> {
  const log = o.log ?? ((l: string) => console.log(l))
  const now = o.now ?? (() => new Date())
  try {
    const mode = parseMode(o.argv)
    if (mode.kind === 'check') return await runCheck(step, o, mode.file, log)
    if (mode.kind === 'restore') return await runRestore(step, o, mode.file, log)
    return await runPlan(step, o, log, now)
  } catch (e) {
    if (e instanceof DataStepRefusal) { log(e.message); return EXIT.refused }
    // lib/privateRecord.ts names Brief 41.1's folder as its example; ours is another.
    if (e instanceof PrivateDirRefusal) { log(e.message.replace(defaultPrivateDir(), defaultBeforeCopyDir())); return EXIT.refused }
    throw e
  }
}

async function runPlan<P>(step: Step<P>, o: RunOptions, log: (l: string) => void, now: () => Date): Promise<number> {
  const expect = parseExpect(o.argv)
  const dir = beforeCopyDirFrom(o.argv)
  if (o.apply) assertPrivateDir(dir, o.repoRoot) // refuse a bad folder before reading anything
  const dry = await readOnly(o.db, async tx => step.plan(tx, await orgIdBySlug(tx, ORG_SLUG), o.argv, null))
  log(`${step.id}: ${step.title}. Database "${o.database ?? '(not set)'}", organization ${ORG_SLUG}.`)
  for (const n of dry.notices) log(`NOTE: ${n}`)
  log(show(dry.summary))
  if (!o.apply) {
    if (dry.refusals.length) log(`--apply would refuse: ${dry.refusals.join(' ')}`)
    else if (dry.expect === 0) log('Dry run: nothing changed, and there is nothing to do.')
    else log(`Dry run: nothing changed. To apply exactly this plan, re-run with --apply --expect ${dry.expect} (on the live database also --i-mean-live).`)
    return EXIT.ok
  }
  if (dry.refusals.length) throw new DataStepRefusal(`Refusing: ${dry.refusals.join(' ')} Nothing changed.`)
  if (dry.expect === 0) { log('Nothing to do: nothing changed.'); return EXIT.ok }
  assertExpect(expect, dry.expect, step.unit)
  if (!o.database) throw new DataStepRefusal("Refusing: the database name can't be read from DATABASE_URL. Nothing changed.")

  const at = now()
  const database = o.database
  const done: { file: string | null; copy: BeforeCopy | null } = { file: null, copy: null }
  try {
    await writeTransaction(o.db, async tx => {
      const orgId = await orgIdBySlug(tx, ORG_SLUG)
      const r = await step.plan(tx, orgId, o.argv, dry.mentions)
      if (r.refusals.length) throw new DataStepRefusal(`Refusing: ${r.refusals.join(' ')} Rolled back; nothing changed.`)
      assertExpect(expect, r.expect, step.unit)
      const copy = step.newCopy(database, orgId, at, r)
      done.copy = copy
      await step.apply(tx, r, copy, c => (done.file = writeBeforeCopy(dir, o.repoRoot, c, at)))
    })
  } catch (e) {
    if (done.file) log(`The before-copy was written (${done.file}) but the transaction was rolled back: nothing changed. Re-run the dry run.`)
    throw e
  }
  if (!done.copy || !done.file) throw new Error('the write transaction ended without a before-copy')
  log(`Applied in one transaction. Before-copy (private): ${done.file}`)
  return afterCheck(step, o, done.copy, log)
}

async function afterCheck<P>(step: Step<P>, o: RunOptions, copy: BeforeCopy, log: (l: string) => void): Promise<number> {
  const result = await readOnly(o.db, async tx => ({ rows: await checkApplied(tx, copy), step: await step.check(tx, copy) }))
  const ok = result.rows.ok && result.step.ok
  log(`After-check (read-only): ${ok ? 'OK' : 'PROBLEMS FOUND'}`)
  log(show({ ...result.step.counts, ...result.rows.problems, callListRebuiltSince: result.rows.callListRebuiltSince }))
  return ok ? EXIT.ok : EXIT.checkFailed
}

async function runCheck<P>(step: Step<P>, o: RunOptions, file: string, log: (l: string) => void): Promise<number> {
  const copy = readBeforeCopy(file, step.id, o.database)
  log(`${step.id}: after-check of ${basename(file)}. Database "${o.database}".`)
  return afterCheck(step, o, copy, log)
}

function restoreSummary(p: RestorePlan) {
  return {
    perTable: p.counts,
    skipped: p.skipped,
    refusals: Object.fromEntries(Object.entries(p.refusals).map(([r, ids]) => [r, { rows: ids.length, ids: someIds(ids) }])),
    rowsWritten: p.writes,
    expect: p.writes,
  }
}

async function runRestore<P>(step: Step<P>, o: RunOptions, file: string, log: (l: string) => void): Promise<number> {
  const expect = parseExpect(o.argv)
  const copy = readBeforeCopy(file, step.id, o.database)
  const dry = await readOnly(o.db, async tx => {
    const orgId = await orgIdBySlug(tx, ORG_SLUG)
    if (orgId !== copy.organizationId) throw new DataStepRefusal('Refusing: the before-copy is from another organization. Nothing changed.')
    return planRestore(copy, await loadRestoreFacts(tx, copy))
  })
  log(`${step.id}: restore from ${basename(file)}. Database "${o.database}".`)
  log(show(restoreSummary(dry)))
  const refused = Object.keys(dry.refusals)
  if (!o.apply) {
    if (refused.length) log(`--apply would refuse: ${refused.join('; ')}.`)
    else if (dry.writes === 0) log('Dry run: nothing changed, and there is nothing to restore.')
    else log(`Dry run: nothing changed. To restore, re-run with ${RESTORE_FLAG} <file> --apply --expect ${dry.writes} (on the live database also --i-mean-live).`)
    return EXIT.ok
  }
  if (refused.length) throw new DataStepRefusal(`Refusing to restore: ${refused.join('; ')}. Nothing changed.`)
  if (dry.writes === 0) { log('Nothing to restore: nothing changed.'); return EXIT.ok }
  assertExpect(expect, dry.writes, 'rows')
  const plan = await writeTransaction(o.db, async tx => {
    const p = planRestore(copy, await loadRestoreFacts(tx, copy))
    if (Object.keys(p.refusals).length) throw new DataStepRefusal(`Refusing to restore: ${Object.keys(p.refusals).join('; ')}. Rolled back; nothing changed.`)
    assertExpect(expect, p.writes, 'rows')
    await applyRestore(tx, p)
    await auditRow(tx, copy.organizationId, step.restoreAction, { beforeCopy: basename(file), rowsWritten: p.writes, perTable: p.counts, skipped: p.skipped })
    return p
  })
  log('Restored in one transaction.')
  const check = await readOnly(o.db, tx => checkRestored(tx, plan))
  log(`Restore check (read-only): ${check.ok ? 'OK' : 'PROBLEMS FOUND'}`)
  log(show({ mismatchedRows: check.mismatched, vectorColumnsNotIdentical: check.looseColumnsDiffer }))
  return check.ok ? EXIT.ok : EXIT.checkFailed
}
