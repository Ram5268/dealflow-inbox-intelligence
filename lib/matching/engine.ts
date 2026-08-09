// Brief 7.0 — cross-source matching engine (callable library, NOT a production
// trigger). findMatchesForListing / findMatchesForParty each: load one side,
// assemble the opposite-side candidate pool, drop user-dismissed pairs, geo
// pre-filter, cap the pool, LLM-tier each survivor (with a spend kill-switch),
// drop 'None', rank (hardcoded SE boost), cap, and return with cost metadata.
//
// Isolation: the fixture harness calls these directly against isTestData rows.
// The engine pulls the real MojoContact table ONLY for non-test queries (that
// table has no isTestData column), so fixture runs can never touch real Mojo
// data. Nothing here is wired to a production save-hook / webhook / cron —
// those are Brief 7.2's scope (gated by lib/config/matchingTestMode.ts).
import { createHash } from 'crypto'
import { Category } from '@prisma/client'
import { prisma } from '../prisma'
import { SUPPLY_SALE, SUPPLY_RENTAL } from '../domain/Categories'
import { isMatchingTestModeOnly } from '../config/matchingTestMode'
import { geoAllows, type GeoRecord } from './geoFilter'
import { tierMatch } from './tiering'
import { rankMatches, rankScoreFor, SORTED_BY_EXPLANATION } from './ranking'
import { describeParty } from './format'
import { killSwitchUsd, MatchingCostAbort } from './cost'
import type {
  MatchResult, MatchQueryResult, PartyContext, ListingContext, SourceBadge,
} from './types'

const SALE_SET = new Set<Category>(SUPPLY_SALE)
const RENTAL_SET = new Set<Category>(SUPPLY_RENTAL)

const DEFAULT_CAP = 25
function maxCandidates(): number {
  const raw = process.env.MATCHING_MAX_CANDIDATES
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : 20
}

// Fields we read off an ExtractedOpportunity for either side of a match.
const OPP_SELECT = {
  id: true, category: true, extractedTitle: true, address: true, neighborhood: true,
  borough: true, price: true, minPrice: true, maxPrice: true, beds: true,
  minBeds: true, maxBeds: true, neighborhoods: true, mustHaves: true, timeline: true,
  sourceBrokerage: true, sourceAgentName: true, isTestData: true, createdAt: true,
} as const

type OppRow = {
  id: string; category: Category; extractedTitle: string
  address: string | null; neighborhood: string | null; borough: string | null
  price: number | null; minPrice: number | null; maxPrice: number | null
  beds: number | null; minBeds: number | null; maxBeds: number | null
  neighborhoods: string[]; mustHaves: string | null; timeline: string | null
  sourceBrokerage: string | null; sourceAgentName: string | null
  isTestData: boolean; createdAt: Date
}

// Source resolution — DETERMINISTIC, drives the SE ranking boost. In 7.0 all
// fixture parties are ExtractedOpportunity rows whose `sourceBrokerage` encodes
// the source (the schema has no dedicated source column, and MatchDismissal is
// the only migration in scope). Real MojoContact rows are always 'mojo'.
export function resolveSourceBadge(sourceBrokerage: string | null): SourceBadge {
  const s = (sourceBrokerage ?? '').toLowerCase()
  if (/street\s*easy/.test(s)) return 'streeteasy_expert'
  if (/\bmojo\b/.test(s)) return 'mojo'
  return 'inbox'
}

function oppToParty(o: OppRow): PartyContext {
  const role = o.category === Category.RENTER_INQUIRY ? 'renter' : 'buyer'
  const hoods = o.neighborhoods.length ? o.neighborhoods : (o.neighborhood ? [o.neighborhood] : [])
  return {
    id:            o.id,
    name:          o.extractedTitle || o.sourceAgentName || 'Unnamed party',
    source:        resolveSourceBadge(o.sourceBrokerage),
    role,
    budgetMin:     o.minPrice,
    budgetMax:     o.maxPrice,
    neighborhoods: hoods,
    bedsMin:       o.minBeds,
    bedsMax:       o.maxBeds,
    cashOnly:      /cash/i.test(o.mustHaves ?? ''),
    timing:        o.timeline,
    borough:       o.borough,
    createdAt:     o.createdAt,
  }
}

function oppToListing(o: OppRow): ListingContext {
  return {
    id:           o.id,
    category:     o.category,
    side:         RENTAL_SET.has(o.category) ? 'rental' : 'sale',
    source:       resolveSourceBadge(o.sourceBrokerage),
    address:      o.address,
    neighborhood: o.neighborhood,
    borough:      o.borough,
    beds:         o.beds,
    price:        o.price,
    createdAt:    o.createdAt,
  }
}

// Deferred production path (Brief 7.2): pull demand-side MojoContact rows. Only
// invoked for real (non-test) queries — MojoContact has no isTestData column, so
// it must never be read during a fixture run. Mapped into low-info parties (the
// table carries no beds/budget-range columns today), tagged source='mojo'.
async function loadMojoDemandParties(role: 'buyer' | 'renter'): Promise<PartyContext[]> {
  const rows = await prisma.mojoContact.findMany({
    where: { tags: { hasSome: role === 'buyer' ? ['buyer', 'Buyer', 'BUYER'] : ['renter', 'Renter', 'RENTER'] } },
    take: 100,
    select: { id: true, fullName: true, neighborhood: true, address: true, estimatedValue: true, createdAt: true },
  })
  return rows.map(m => ({
    id:            m.id,
    name:          m.fullName,
    source:        'mojo' as const,
    role,
    budgetMin:     null,
    budgetMax:     m.estimatedValue ?? null,
    neighborhoods: m.neighborhood ? [m.neighborhood] : [],
    bedsMin:       null,
    bedsMax:       null,
    cashOnly:      false,
    timing:        null,
    borough:       null,
    createdAt:     m.createdAt,
  }))
}

// A listing carries a single neighborhood; the geo filter wants a list.
function listingGeo(l: ListingContext): GeoRecord {
  return { borough: l.borough, neighborhoods: l.neighborhood ? [l.neighborhood] : [] }
}

export function matchId(partyId: string, listingId: string): string {
  return createHash('sha1').update(`${partyId}::${listingId}`).digest('hex').slice(0, 16)
}

function ageDays(d: Date, now: number): number {
  return Math.max(0, (now - d.getTime()) / 86_400_000)
}

// Set of "partyId::listingId" keys the user has dismissed, for a given pool of
// candidate pairs. Applied BEFORE geo/tiering so a dismissed pair never costs a
// Sonnet call (a permissible cost-saving reordering of the brief's steps 8/9 —
// the observable result set is identical).
async function loadDismissedKeys(pairs: Array<{ partyId: string; listingId: string }>): Promise<Set<string>> {
  if (!pairs.length) return new Set()
  const rows = await prisma.matchDismissal.findMany({
    where: { OR: pairs },
    select: { partyId: true, listingId: true },
  })
  return new Set(rows.map(d => `${d.partyId}::${d.listingId}`))
}

interface Pair { party: PartyContext; listing: ListingContext }

// Shared tier→rank→cap pipeline over a fixed set of geo-approved pairs.
async function scorePairs(pairs: Pair[], now: number, limit: number): Promise<MatchQueryResult> {
  const threshold = killSwitchUsd()
  let costUSD = 0
  let evaluated = 0
  const scored: MatchResult[] = []

  for (const { party, listing } of pairs) {
    if (costUSD >= threshold) throw new MatchingCostAbort(costUSD, evaluated, threshold)
    const outcome = await tierMatch(party, listing, now)
    costUSD += outcome.costUsd
    evaluated++

    if (outcome.error) {
      console.warn(`[matching] tiering failed for ${party.id}↔${listing.id}: ${outcome.error} — treating as None`)
      continue
    }
    if (outcome.tier === 'None') continue

    const recencyDays = Math.min(ageDays(party.createdAt, now), ageDays(listing.createdAt, now))
    scored.push({
      id:          matchId(party.id, listing.id),
      party:       { id: party.id, name: party.name, source: party.source, role: party.role, criteria: describeParty(party) },
      listing:     { id: listing.id, address: listing.address, neighborhood: listing.neighborhood, price: listing.price, category: listing.category },
      tier:        outcome.tier,
      reason:      outcome.reason,
      rankScore:   rankScoreFor(outcome.tier, party.source),
      recencyDays: Number(recencyDays.toFixed(2)),
      sourceBadge: party.source,
    })
  }

  const ranked = rankMatches(scored)
  return {
    results:      ranked.slice(0, limit),
    totalMatched: ranked.length,          // after None-filter + dismissals, before the cap
    sortedBy:     SORTED_BY_EXPLANATION,
    costUSD:      Number(costUSD.toFixed(6)),
  }
}

// Cap the candidate pool. If geo left >max, keep the newest `max` (a listing's
// counterparties are demand records; freshest demand is the safest to keep) and
// LOG the truncation — never silently blow the budget, never silently hide work.
function capByRecency<T extends { createdAt: Date }>(items: T[], now: number, label: string): T[] {
  const max = maxCandidates()
  if (items.length <= max) return items
  console.warn(`[matching] ${label}: ${items.length} candidates after geo filter > cap ${max}; truncating to newest ${max} by recency.`)
  return [...items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, max)
}

const EMPTY = (): MatchQueryResult => ({ results: [], totalMatched: 0, sortedBy: SORTED_BY_EXPLANATION, costUSD: 0 })

/** Find demand (buyer/renter parties) that matches a given supply listing. */
export async function findMatchesForListing(
  listingId: string, options?: { limit?: number },
): Promise<MatchQueryResult> {
  const now = Date.now()
  const limit = options?.limit ?? DEFAULT_CAP

  const row = await prisma.extractedOpportunity.findUnique({ where: { id: listingId }, select: OPP_SELECT }) as OppRow | null
  if (!row) throw new Error(`findMatchesForListing: listing ${listingId} not found`)
  if (!SALE_SET.has(row.category) && !RENTAL_SET.has(row.category)) {
    throw new Error(`findMatchesForListing: ${listingId} is category ${row.category}, not a SUPPLY listing`)
  }
  const listing = oppToListing(row)

  // Transaction side: sale listing ↔ buyer parties; rental listing ↔ renter parties.
  const partyCategory = listing.side === 'sale' ? Category.BUYER_ISO : Category.RENTER_INQUIRY

  const oppParties = await prisma.extractedOpportunity.findMany({
    where: {
      category: partyCategory,
      isDuplicate: false,
      isTestData: row.isTestData,                 // isolate: seed rows match seed listing
      // NOTE: the Brief 6.3 `provenance != 'comp_reference'` guard is intentionally
      // omitted — main's schema has no `provenance` field yet (6.3 is not merged to
      // main; only its shared-DB column exists). Re-add this guard once 6.3 lands.
    },
    select: OPP_SELECT,
  }) as OppRow[]

  let parties: PartyContext[] = oppParties.map(oppToParty)

  // Deferred cross-source: real Mojo demand, only for non-test queries.
  if (!row.isTestData && !isMatchingTestModeOnly()) {
    parties = parties.concat(await loadMojoDemandParties(listing.side === 'sale' ? 'buyer' : 'renter'))
  }

  const dismissed = await loadDismissedKeys(parties.map(p => ({ partyId: p.id, listingId })))
  parties = parties.filter(p => !dismissed.has(`${p.id}::${listingId}`))
  const lg = listingGeo(listing)
  parties = parties.filter(p => geoAllows(p, lg))
  parties = capByRecency(parties, now, `listing ${listingId}`)
  if (!parties.length) return EMPTY()

  return scorePairs(parties.map(party => ({ party, listing })), now, limit)
}

/** Find supply (listings) that matches a given demand party. */
export async function findMatchesForParty(
  partyId: string, options?: { limit?: number },
): Promise<MatchQueryResult> {
  const now = Date.now()
  const limit = options?.limit ?? DEFAULT_CAP

  const row = await prisma.extractedOpportunity.findUnique({ where: { id: partyId }, select: OPP_SELECT }) as OppRow | null
  if (!row) throw new Error(`findMatchesForParty: party ${partyId} not found`)
  if (row.category !== Category.BUYER_ISO && row.category !== Category.RENTER_INQUIRY) {
    throw new Error(`findMatchesForParty: ${partyId} is category ${row.category}, not a demand party`)
  }
  const party = oppToParty(row)

  // Transaction side: buyer ↔ sale supply; renter ↔ rental supply.
  const listingCats = party.role === 'buyer' ? [...SUPPLY_SALE] : [...SUPPLY_RENTAL]

  const oppListings = await prisma.extractedOpportunity.findMany({
    where: {
      category: { in: listingCats },
      isDuplicate: false,
      isTestData: row.isTestData,
      // See note above: `provenance` guard deferred until Brief 6.3 merges to main.
    },
    select: OPP_SELECT,
  }) as OppRow[]

  let listings: ListingContext[] = oppListings.map(oppToListing)

  const dismissed = await loadDismissedKeys(listings.map(l => ({ partyId, listingId: l.id })))
  listings = listings.filter(l => !dismissed.has(`${partyId}::${l.id}`))
  listings = listings.filter(l => geoAllows(party, listingGeo(l)))
  listings = capByRecency(listings, now, `party ${partyId}`)
  if (!listings.length) return EMPTY()

  return scorePairs(listings.map(listing => ({ party, listing })), now, limit)
}
