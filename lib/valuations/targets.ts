import type { PrismaClient } from '@prisma/client'
import { crmSellerWhere, LATEST_PUBLISHED_FIRST } from './importRun'

// Brief 44 — GET /api/valuations/targets (protected): the CRM sellers the monthly job
// values. Only what valuing a home needs: the property address, the lead's own unit
// count and size (for the "lead says vs city says" facts) and the tax lot an earlier
// published run matched. No name, phone, email or mailing address.

export interface Target {
  contactId: string
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  unitCount: number | null
  buildingSqft: number | null
  cachedBbl: string | null
}

export async function buildTargets(db: PrismaClient, organizationId: string) {
  const [sellers, cached, previous] = await Promise.all([
    db.mojoContact.findMany({
      where: crmSellerWhere(organizationId),
      select: { id: true, address: true, city: true, state: true, zipCode: true, unitCount: true, buildingSqft: true },
      orderBy: { id: 'asc' },
    }),
    // The newest matched tax lot per seller, from published runs only: a run that
    // failed its checks may have matched the wrong lot (engineering precaution).
    db.propertyValuation.findMany({
      where: { organizationId, bbl: { not: null }, run: { published: true } },
      orderBy: [{ contactId: 'asc' }, { createdAt: 'desc' }],
      distinct: ['contactId'],
      select: { contactId: true, bbl: true },
    }),
    // The last published run's numbers, so this run's report can show the change.
    db.valuationRun.findFirst({
      where: { organizationId, published: true },
      orderBy: LATEST_PUBLISHED_FIRST,
      select: { id: true, asOf: true, publishedAt: true, metricsJson: true, scoreboardJson: true, countsJson: true },
    }),
  ])
  const bblOf = new Map(cached.map(c => [c.contactId, c.bbl]))
  const targets: Target[] = sellers.map(s => ({
    contactId: s.id,
    address: s.address,
    city: s.city,
    state: s.state,
    zip: s.zipCode,
    unitCount: s.unitCount,
    buildingSqft: s.buildingSqft,
    cachedBbl: bblOf.get(s.id) ?? null,
  }))
  return {
    ok: true,
    sellers: targets,
    previousPublished: previous
      ? {
          runId: previous.id,
          asOf: previous.asOf.toISOString().slice(0, 10),
          publishedAt: previous.publishedAt?.toISOString() ?? null,
          metrics: previous.metricsJson,
          scoreboard: previous.scoreboardJson,
          counts: previous.countsJson,
        }
      : null,
  }
}
