import type { PrismaClient } from '@prisma/client'
import { GATE_KEYS, MODEL_VERSION, recheckGates } from './contract'
import { LATEST_PUBLISHED_FIRST } from './importRun'

// Brief 44 — GET /api/valuations/status (public, like /api/debug/health): when the
// monthly job last ran, whether it published, its counts and its gate results, and
// (Brief 49) how many days old the newest published run is.
// It never shows a value, an address, a tax lot, a contact, the metrics or the
// scoreboard: every field below is rebuilt from a fixed list, so nothing else stored
// on a run can reach it (engineering precaution).

const COUNT_KEYS = [
  'targets', 'valued', 'five_plus_units', 'condo_without_unit', 'not_found', 'other_property_type', 'trainingSales', 'gateSales',
] as const

const RUN_SELECT = {
  runAt: true, asOf: true, dataThrough: true, modelVersion: true, published: true, publishedAt: true,
  gatesPassed: true, gatesJson: true, countsJson: true,
} as const

type RunRow = {
  runAt: Date; asOf: Date; dataThrough: Date; modelVersion: string; published: boolean; publishedAt: Date | null
  gatesPassed: boolean; gatesJson: unknown; countsJson: unknown
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10)

function publicRun(r: RunRow) {
  const reported = (r.gatesJson as { reported?: { checks?: unknown } } | null)?.reported?.checks
  const gates = recheckGates(reported).checks.map(g => ({
    key: g.key,
    value: Number.isFinite(g.value) ? g.value : null,
    min: g.min,
    max: g.max,
    pass: g.pass,
  }))
  const raw = (r.countsJson ?? {}) as Record<string, unknown>
  const counts = Object.fromEntries(
    COUNT_KEYS.map(k => [k, typeof raw[k] === 'number' && Number.isInteger(raw[k]) ? (raw[k] as number) : null]),
  )
  return {
    runAt: r.runAt.toISOString(),
    asOf: dayOf(r.asOf),
    dataThrough: dayOf(r.dataThrough),
    // A code by the import's rules; anything else stored is not shown.
    modelVersion: MODEL_VERSION.test(r.modelVersion) ? r.modelVersion : null,
    published: r.published,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    gatesPassed: r.gatesPassed,
    gates,
    counts,
  }
}

// Brief 49 (PR 3): whole days since the newest published run was published, rounded down.
// Matching stops using values more than 100 days (100 x 24 hours) old (lib/matching/ourEstimates.ts,
// MAX_VALUE_AGE_DAYS), so on the day this shows 100 they may already be out.
const ageInDays = (publishedAt: Date | null, now: Date) =>
  publishedAt ? Math.max(0, Math.floor((now.getTime() - publishedAt.getTime()) / 86_400_000)) : null

export async function buildStatus(db: PrismaClient, organizationId: string, now: Date = new Date()) {
  const [latest, latestPublished] = await Promise.all([
    db.valuationRun.findFirst({ where: { organizationId }, orderBy: [{ runAt: 'desc' }, { createdAt: 'desc' }], select: RUN_SELECT }),
    db.valuationRun.findFirst({ where: { organizationId, published: true }, orderBy: LATEST_PUBLISHED_FIRST, select: RUN_SELECT }),
  ])
  return {
    ok: true,
    message: latest ? null : 'no runs yet',
    gateKeys: GATE_KEYS,
    latestRun: latest ? publicRun(latest as RunRow) : null,
    latestPublished: latestPublished
      ? { ...publicRun(latestPublished as RunRow), ageDays: ageInDays((latestPublished as RunRow).publishedAt, now) }
      : null,
  }
}
