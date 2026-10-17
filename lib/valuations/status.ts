import type { PrismaClient } from '@prisma/client'
import { GATE_KEYS, recheckGates } from './contract'

// Brief 44 — GET /api/valuations/status (public, like /api/debug/health): when the
// monthly job last ran, whether it published, its counts and its gate results.
// It never shows a value, an address, a tax lot or a contact: every field below is
// rebuilt from a fixed list, so nothing else stored on a run can reach it.

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
    modelVersion: r.modelVersion.slice(0, 80),
    published: r.published,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    gatesPassed: r.gatesPassed,
    gates,
    counts,
  }
}

export async function buildStatus(db: PrismaClient, organizationId: string) {
  const [latest, latestPublished] = await Promise.all([
    db.valuationRun.findFirst({ where: { organizationId }, orderBy: { runAt: 'desc' }, select: RUN_SELECT }),
    db.valuationRun.findFirst({ where: { organizationId, published: true }, orderBy: { publishedAt: 'desc' }, select: RUN_SELECT }),
  ])
  return {
    ok: true,
    message: latest ? null : 'no runs yet',
    gateKeys: GATE_KEYS,
    latestRun: latest ? publicRun(latest as RunRow) : null,
    latestPublished: latestPublished ? publicRun(latestPublished as RunRow) : null,
  }
}
