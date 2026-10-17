import { Prisma, type PrismaClient } from '@prisma/client'
import {
  GATE_LIMITS,
  ImportSchema,
  issueList,
  recheckGates,
  type ValuationRow,
  type ValuationRunInput,
} from './contract'

// Brief 44 — what POST /api/valuations/import does with each step (see contract.ts).
// The database is passed in, so the tests run it against an in-memory stand-in.

export type ImportResult = { status: number; body: Record<string, unknown> }

// Values of the 12 most recent published runs are kept, and the newest published run
// is always among them, so a run that fails its checks never removes the values the
// CRM shows. Run records themselves are never deleted.
export const KEEP_PUBLISHED_RUNS = 12
// Rows of a run that was never published (an upload that stopped half-way) are
// cleared once they are this old.
export const ABANDONED_AFTER_MS = 2 * 24 * 60 * 60 * 1000

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): ImportResult => ({
  status,
  body: { ok: false, error, ...extra },
})
const ok = (body: Record<string, unknown>): ImportResult => ({ status: 200, body: { ok: true, ...body } })

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const jsonOrNull = (v: unknown) => (v == null ? Prisma.DbNull : (v as Prisma.InputJsonValue))

// CRM sellers are the only homes the job values (the same set nightly scoring uses).
export const crmSellerWhere = (organizationId: string) => ({
  organizationId,
  isTestData: false,
  metadata: { path: ['source'], equals: 'crm' },
})

class Conflict extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export async function handleImport(db: PrismaClient, organizationId: string, payload: unknown, now = new Date()): Promise<ImportResult> {
  const parsed = ImportSchema.safeParse(payload)
  if (!parsed.success) return fail(400, 'invalid_payload', { issues: issueList(parsed.error) })
  const p = parsed.data
  if (p.action === 'start') return startRun(db, organizationId, p.run)
  if (p.action === 'rows') return addRows(db, organizationId, p.runId, p.rows, now)
  return publishRun(db, organizationId, p.runId, now)
}

async function startRun(db: PrismaClient, organizationId: string, run: ValuationRunInput): Promise<ImportResult> {
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
  }
  const existing = await db.valuationRun.findUnique({
    where: { id: run.runId },
    select: { organizationId: true, published: true },
  })
  if (existing && existing.organizationId !== organizationId) return fail(409, 'run_id_taken')
  if (existing?.published) return fail(409, 'already_published')
  if (existing) await db.valuationRun.update({ where: { id: run.runId }, data })
  else await db.valuationRun.create({ data: { id: run.runId, ...data } })
  return ok({ runId: run.runId, gatesPassed })
}

async function addRows(db: PrismaClient, organizationId: string, runId: string, rows: ValuationRow[], now: Date): Promise<ImportResult> {
  const ids = rows.map(r => r.contactId)
  if (new Set(ids).size !== ids.length) return fail(400, 'duplicate_contact_in_batch')
  const run = await db.valuationRun.findFirst({ where: { id: runId, organizationId }, select: { published: true, asOf: true } })
  if (!run) return fail(404, 'run_not_found')
  if (run.published) return fail(409, 'already_published')
  const known = await db.mojoContact.findMany({ where: { ...crmSellerWhere(organizationId), id: { in: ids } }, select: { id: true } })
  if (known.length !== ids.length) return fail(422, 'unknown_contacts', { unknown: ids.length - known.length })
  try {
    await db.$transaction(async tx => {
      // Takes the run's row lock, so a publish can't slip in between the checks and the write.
      const lock = await tx.valuationRun.updateMany({ where: { id: runId, organizationId, published: false }, data: { updatedAt: now } })
      if (lock.count !== 1) throw new Conflict('already_published')
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
    })
  } catch (e) {
    if (e instanceof Conflict) return fail(409, e.code)
    throw e
  }
  const totalRows = await db.propertyValuation.count({ where: { runId } })
  return ok({ runId, received: rows.length, totalRows })
}

async function publishRun(db: PrismaClient, organizationId: string, runId: string, now: Date): Promise<ImportResult> {
  try {
    return await db.$transaction(
      async tx => {
        const run = await tx.valuationRun.findFirst({
          where: { id: runId, organizationId },
          select: { published: true, gatesPassed: true, gatesJson: true, expectedRows: true },
        })
        if (!run) return fail(404, 'run_not_found')
        if (run.published) return ok({ runId, published: true, alreadyPublished: true })
        const lock = await tx.valuationRun.updateMany({ where: { id: runId, organizationId, published: false }, data: { updatedAt: now } })
        if (lock.count !== 1) throw new Conflict('already_published')
        const reported = (run.gatesJson as { reported?: { checks?: unknown } } | null)?.reported?.checks
        if (!run.gatesPassed || !recheckGates(reported).passed) return fail(409, 'gates_failed')
        const rows = await tx.propertyValuation.count({ where: { runId } })
        if (rows !== run.expectedRows) return fail(409, 'row_count_mismatch', { rows, expectedRows: run.expectedRows })
        const valued = await tx.propertyValuation.count({ where: { runId, value: { not: null } } })
        const minValued = GATE_LIMITS.sellers_valued.min ?? 0
        if (valued < minValued) return fail(409, 'too_few_valued', { valued, minimum: minValued })
        await tx.valuationRun.update({ where: { id: runId }, data: { published: true, publishedAt: now } })
        const prunedRows = await prune(tx, organizationId, now)
        return ok({ runId, published: true, rows, valued, prunedRows })
      },
      { maxWait: 10_000, timeout: 30_000 },
    )
  } catch (e) {
    if (e instanceof Conflict) return fail(409, e.code)
    throw e
  }
}

export async function prune(tx: Prisma.TransactionClient, organizationId: string, now: Date): Promise<number> {
  const published = await tx.valuationRun.findMany({
    where: { organizationId, published: true },
    orderBy: { publishedAt: 'desc' },
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
