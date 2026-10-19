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

// Brief 49 (PR 5; Ryan's open item 5.6): a condo needs its unit number. The CRM copy keeps
// only the street part of the lead's address (lib/crm-sync/mapLead.ts), so a unit written after
// a comma never reaches DealFlow. Some leads still carry their own unit in the Mojo fields the
// old Mojo webhook kept in metadata.unmapped (Brief 7.2), or in a unit / second-address-line
// key. When the address has no unit, that one is added as "#<unit>", the form the monthly job
// reads (valuation/dfval/targets.py). Nothing else in metadata leaves DealFlow.
const UNIT_KEYS = new Set([
  'unit', 'unitnumber', 'apt', 'aptnumber', 'apartment', 'apartmentnumber', 'suite',
  'address2', 'addressline2', 'streetaddress2', 'propertyunit', 'propertyunitnumber', 'propertyapt',
  'propertyapartment', 'propertyaddress2', 'propertyaddressline2',
])
// The unit markers valuation/dfval/targets.py reads from an address (its UNIT and
// TRAILING_COMMA_UNIT patterns).
const HAS_UNIT = /(?:(?:\s*,\s*|\s+)(?:#\s*|APT\.?\s*|APARTMENT\s+|UNIT\s+|STE\.?\s+|SUITE\s+|FL\.?\s+|FLOOR\s+|RM\s+)[A-Z0-9-]+|\s*,\s*[A-Z0-9-]{1,6})\s*$/i
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const keyOf = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '')

// A unit written as "2R", "Apt 2R", "#2R" or "Unit 2-R" -> "2R" / "2-R"; anything that isn't a
// short unit code (a whole address, a sentence) -> null.
export function cleanUnit(raw: unknown): string | null {
  if (typeof raw !== 'string' && !(typeof raw === 'number' && Number.isInteger(raw) && raw > 0)) return null
  const u = String(raw).toUpperCase().replace(/^\s*(#|NO\.?|NUMBER|APT\.?|APARTMENT|UNIT|STE\.?|SUITE)\s*/, '').replace(/^#\s*/, '').trim()
  return /^[A-Z0-9][A-Z0-9-]{0,5}$/.test(u) ? u : null
}

// The lead's own unit from metadata: the old Mojo fields first, then metadata itself.
export function leadUnit(metadata: unknown): string | null {
  if (!isObject(metadata)) return null
  for (const place of [metadata.unmapped, metadata]) {
    if (!isObject(place)) continue
    for (const [k, v] of Object.entries(place)) {
      if (!UNIT_KEYS.has(keyOf(k))) continue
      const u = cleanUnit(v)
      if (u) return u
    }
  }
  return null
}

export function addressWithUnit(address: string | null, metadata: unknown): { address: string | null; added: boolean } {
  if (!address || HAS_UNIT.test(address)) return { address, added: false }
  const unit = leadUnit(metadata)
  return unit ? { address: `${address.trim()} #${unit}`, added: true } : { address, added: false }
}

export async function buildTargets(db: PrismaClient, organizationId: string) {
  const [sellers, cached, previous] = await Promise.all([
    db.mojoContact.findMany({
      where: crmSellerWhere(organizationId),
      select: { id: true, address: true, city: true, state: true, zipCode: true, unitCount: true, buildingSqft: true, metadata: true },
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
  let unitsFromLeadFields = 0
  const targets: Target[] = sellers.map(s => {
    const a = addressWithUnit(s.address, s.metadata)
    if (a.added) unitsFromLeadFields++
    return {
      contactId: s.id,
      address: a.address,
      city: s.city,
      state: s.state,
      zip: s.zipCode,
      unitCount: s.unitCount,
      buildingSqft: s.buildingSqft,
      cachedBbl: bblOf.get(s.id) ?? null,
    }
  })
  return {
    ok: true,
    sellers: targets,
    // A count only (Brief 49 PR 5): how many sellers' unit numbers came from the lead's own fields.
    unitsFromLeadFields,
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
