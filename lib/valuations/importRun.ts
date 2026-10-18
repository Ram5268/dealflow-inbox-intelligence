import { Prisma, type PrismaClient } from '@prisma/client'
import {
  GATE_LIMITS,
  ImportSchema,
  issueList,
  recheckGates,
  rowDateProblems,
  runTimeProblems,
  type ValuationRow,
  type ValuationRunInput,
} from './contract'

// Brief 44 — what POST /api/valuations/import does with each step (see contract.ts).
// The database is passed in, so the tests run it against an in-memory stand-in.
//
// Each step works inside one transaction that first takes the run's row lock (an
// UPDATE of the run WHERE published = false) and only then reads the run. Postgres
// makes a second writer of the same run wait for the first to finish, so a start, a
// batch and a publish of one run never interleave, every check sees the run as it
// will be written, and a published run never changes again (engineering precaution).

export type ImportResult = { status: number; body: Record<string, unknown> }

// Values of the 12 most recent published runs are kept, and the newest published run
// is always among them, so a run that fails its checks never removes the values the
// CRM shows. Run records themselves are never deleted.
export const KEEP_PUBLISHED_RUNS = 12
// Rows of a run that was never published (an upload that stopped half-way, or a month
// whose checks failed) are removed at the next successful publish once the run is
// more than this old.
export const ABANDONED_AFTER_MS = 2 * 24 * 60 * 60 * 1000
// Every step's transaction waits at most 10 s to start and runs at most 30 s; Prisma's
// defaults (2 s, 5 s) are shorter than a publish may hold the run's lock.
export const TX_LIMITS = { maxWait: 10_000, timeout: 30_000 }
// "Latest published" everywhere: the newest publish time first; a published run
// without one counts as the oldest (Postgres would put it first in a plain DESC).
export const LATEST_PUBLISHED_FIRST: Prisma.ValuationRunOrderByWithRelationInput = { publishedAt: { sort: 'desc', nulls: 'last' } }

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): ImportResult => ({
  status,
  body: { ok: false, error, ...extra },
})
const ok = (body: Record<string, unknown>): ImportResult => ({ status: 200, body: { ok: true, ...body } })

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const dayOf = (d: Date) => d.toISOString().slice(0, 10)
const jsonOrNull = (v: unknown) => (v == null ? Prisma.DbNull : (v as Prisma.InputJsonValue))
const isUniqueViolation = (e: unknown) => (e as { code?: unknown } | null)?.code === 'P2002'

// CRM sellers are the only homes the job values (the same set nightly scoring uses).
export const crmSellerWhere = (organizationId: string) => ({
  organizationId,
  isTestData: false,
  metadata: { path: ['source'], equals: 'crm' },
})

// The run's row lock: true when this transaction now holds it (the run exists, is this
// organization's and isn't published).
async function lockRun(tx: Prisma.TransactionClient, organizationId: string, runId: string, now: Date) {
  const locked = await tx.valuationRun.updateMany({ where: { id: runId, organizationId, published: false }, data: { updatedAt: now } })
  return locked.count === 1
}

export async function handleImport(db: PrismaClient, organizationId: string, payload: unknown, now = new Date()): Promise<ImportResult> {
  const parsed = ImportSchema.safeParse(payload)
  if (!parsed.success) return fail(400, 'invalid_payload', { issues: issueList(parsed.error) })
  const p = parsed.data
  if (p.action === 'start') return startRun(db, organizationId, p.run, now)
  if (p.action === 'rows') return addRows(db, organizationId, p.runId, p.rows, now)
  return publishRun(db, organizationId, p.runId, now)
}

async function startRun(db: PrismaClient, organizationId: string, run: ValuationRunInput, now: Date): Promise<ImportResult> {
  const late = runTimeProblems(run, now)
  if (late.length > 0) return fail(400, 'invalid_payload', { issues: late })
  const checked = recheckGates(run.gates.checks)
  // The job's own verdict counts only when this server agrees with it.
  const gatesPassed = run.gates.passed && checked.passed
  const data = {
    organizationId,
    runAt: new Date(run.runAt),
    asOf: day(run.asOf),
    dataThrough: day(run.dataThrough),
    modelVersion: run.modelVersion,
    gatesPassed,
    gatesJson: { reported: run.gates, checked } as unknown as Prisma.InputJsonValue,
    metricsJson: run.metrics as Prisma.InputJsonValue,
    scoreboardJson: jsonOrNull(run.scoreboard),
    sourcesJson: jsonOrNull(run.sources),
    countsJson: run.counts as Prisma.InputJsonValue,
    expectedRows: run.expectedRows,
    updatedAt: now,
  }
  try {
    return await db.$transaction(async tx => {
      if (!(await lockRun(tx, organizationId, run.runId, now))) {
        const other = await tx.valuationRun.findUnique({ where: { id: run.runId }, select: { organizationId: true, published: true } })
        if (other && other.organizationId !== organizationId) return fail(409, 'run_id_taken')
        if (other) return fail(409, other.published ? 'already_published' : 'retry')
        // A new run. A start creating the same id at the same moment fails on the key: 409 retry.
        await tx.valuationRun.create({ data: { id: run.runId, ...data } })
        return ok({ runId: run.runId, gatesPassed })
      }
      // Once rows are in, the as-of day, the data cut-off and the model are fixed:
      // rows carry the run's as-of day. The rest may change (that's how a run recovers
      // after dropping sellers the import refused).
      const current = await tx.valuationRun.findUnique({ where: { id: run.runId }, select: { asOf: true, dataThrough: true, modelVersion: true } })
      const hasRows = (await tx.propertyValuation.count({ where: { runId: run.runId } })) > 0
      const changed = current != null && (dayOf(current.asOf) !== run.asOf || dayOf(current.dataThrough) !== run.dataThrough || current.modelVersion !== run.modelVersion)
      if (hasRows && changed) return fail(409, 'run_frozen')
      await tx.valuationRun.update({ where: { id: run.runId }, data })
      return ok({ runId: run.runId, gatesPassed })
    }, TX_LIMITS)
  } catch (e) {
    if (isUniqueViolation(e)) return fail(409, 'retry')
    throw e
  }
}

async function addRows(db: PrismaClient, organizationId: string, runId: string, rows: ValuationRow[], now: Date): Promise<ImportResult> {
  const ids = rows.map(r => r.contactId)
  if (new Set(ids).size !== ids.length) return fail(400, 'duplicate_contact_in_batch')
  const written = await db.$transaction(async tx => {
    if (!(await lockRun(tx, organizationId, runId, now))) {
      const run = await tx.valuationRun.findFirst({ where: { id: runId, organizationId }, select: { published: true } })
      // A run that exists but isn't published is one whose start is still being written.
      return run ? fail(409, run.published ? 'already_published' : 'retry') : fail(404, 'run_not_found')
    }
    const run = await tx.valuationRun.findUnique({ where: { id: runId }, select: { asOf: true } })
    if (!run) return fail(404, 'run_not_found')
    const late = rowDateProblems(rows, dayOf(run.asOf))
    if (late.length > 0) return fail(400, 'invalid_payload', { issues: late })
    // Sellers the CRM sync has since dropped (removed, duplicate) or never had: the
    // ids the job sent, so it can drop them and re-send start with fewer expected rows.
    const known = new Set((await tx.mojoContact.findMany({ where: { ...crmSellerWhere(organizationId), id: { in: ids } }, select: { id: true } })).map(k => k.id))
    const unknown = ids.filter(id => !known.has(id))
    if (unknown.length > 0) return fail(422, 'unknown_contacts', { unknown })
    // Re-sending a batch replaces it: same run, same sellers, no duplicates.
    await tx.propertyValuation.deleteMany({ where: { runId, contactId: { in: ids } } })
    await tx.propertyValuation.createMany({
      data: rows.map(r => ({
        runId,
        organizationId,
        contactId: r.contactId,
        bbl: r.bbl,
        value: r.value,
        low: r.low,
        high: r.high,
        asOf: run.asOf,
        reason: r.reason,
        factsJson: jsonOrNull(r.facts),
        compsJson: r.comps as Prisma.InputJsonValue,
      })),
    })
    return ok({ runId, received: rows.length })
  }, TX_LIMITS)
  if (written.status !== 200) return written
  const totalRows = await db.propertyValuation.count({ where: { runId } })
  return ok({ ...written.body, totalRows })
}

async function publishRun(db: PrismaClient, organizationId: string, runId: string, now: Date): Promise<ImportResult> {
  return db.$transaction(async tx => {
    // Publishes take turns, whatever their run (engineering precaution): otherwise two
    // runs publishing at the same moment could both pass the "newer month already
    // published?" check below, and the older month would become "latest". The lock is
    // released when this transaction ends.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(44, hashtext(${`valuation-publish:${organizationId}`}))`
    // Lock first, then read: a start or a batch of this run either finished before
    // this point or waits until this publish is done.
    if (!(await lockRun(tx, organizationId, runId, now))) {
      const done = await tx.valuationRun.findFirst({ where: { id: runId, organizationId }, select: { published: true } })
      if (!done) return fail(404, 'run_not_found')
      // Only a published run is "already published"; one whose start is still being
      // written is told to retry.
      return done.published ? ok({ runId, published: true, alreadyPublished: true }) : fail(409, 'retry')
    }
    const run = await tx.valuationRun.findUnique({
      where: { id: runId },
      select: { asOf: true, gatesPassed: true, gatesJson: true, expectedRows: true },
    })
    if (!run) return fail(404, 'run_not_found')
    const reported = (run.gatesJson as { reported?: { checks?: unknown } } | null)?.reported?.checks
    if (!run.gatesPassed || !recheckGates(reported).passed) return fail(409, 'gates_failed')
    const rows = await tx.propertyValuation.count({ where: { runId } })
    if (rows !== run.expectedRows) return fail(409, 'row_count_mismatch', { rows, expectedRows: run.expectedRows })
    const valued = await tx.propertyValuation.count({ where: { runId, value: { not: null } } })
    const minValued = GATE_LIMITS.sellers_valued.min ?? 0
    if (valued < minValued) return fail(409, 'too_few_valued', { valued, minimum: minValued })
    // Every row must carry the run's as-of day (the card shows it).
    const offDay = await tx.propertyValuation.count({ where: { runId, asOf: { not: run.asOf } } })
    if (offDay > 0) return fail(409, 'as_of_mismatch', { rows: offDay })
    // An older month published late would otherwise become "latest".
    const newer = await tx.valuationRun.findFirst({ where: { organizationId, published: true, asOf: { gt: run.asOf } }, select: { id: true } })
    if (newer) return fail(409, 'older_than_published')
    await tx.valuationRun.update({ where: { id: runId }, data: { published: true, publishedAt: now } })
    const prunedRows = await prune(tx, organizationId, now)
    return ok({ runId, published: true, rows, valued, prunedRows })
  }, TX_LIMITS)
}

export async function prune(tx: Prisma.TransactionClient, organizationId: string, now: Date): Promise<number> {
  const published = await tx.valuationRun.findMany({
    where: { organizationId, published: true },
    orderBy: LATEST_PUBLISHED_FIRST,
    select: { id: true },
  })
  const abandoned = await tx.valuationRun.findMany({
    where: { organizationId, published: false, createdAt: { lt: new Date(now.getTime() - ABANDONED_AFTER_MS) } },
    select: { id: true },
  })
  const drop = [...published.slice(KEEP_PUBLISHED_RUNS), ...abandoned].map(r => r.id)
  if (drop.length === 0) return 0
  return (await tx.propertyValuation.deleteMany({ where: { runId: { in: drop } } })).count
}
