// Brief 43 PR 5 (D11 [Ryan, 2026-10-18]; by address D13 [Ryan, 2026-10-19]):
// Ryan's CRM sellers in chat. Drift never lists or searches them; it gives one
// named seller's contact (asked for by name or by street address) and counts.
// DealFlow itself still reads every seller for matching, ranking and counts.
//
// Every lookup is a database query over the WHOLE pool, never the newest-500
// window the old search_parties read (N2), so the oldest seller is found as
// readily as the newest. Brief 43 PR 6 (matches by seller) reuses these lookups,
// and PR 12 adds our estimate to the card (CONTRACT.md).
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { crmLeadUrl } from '@/lib/crmLink'
import { normalizeStreet } from '@/lib/crm-sync/addressNormalize'
import { BOROUGHS, NEIGHBORHOODS, fromRaw } from '@/lib/domain/Neighborhood'
import { formatPhone, isOptOutWording, type SellerCandidate, type SellerCard } from './sellerCard'

export type { SellerCard, SellerCandidate } from './sellerCard'

// The seller pool: the nightly scoring pool (lib/matching/nightly/runScoring.ts
// loadScoringInputs: real rows whose metadata.source is 'crm'), plus intent
// SELLER (Q8: CRM-stored buyers and renters are never sellers). The CRM sync
// marks the records it must not use with a different source, so this one
// equality leaves them all out (Q28): 'duplicate' (a csv copy of a CRM lead),
// 'crm_removed' (gone from the CRM) and 'legacy' (never matched to a CRM lead),
// see lib/crm-sync/upsert.ts. Seed rows are isTestData.
export function crmSellerPoolWhere(organizationId: string): Prisma.MojoContactWhereInput {
  return { organizationId, isTestData: false, intent: 'SELLER', metadata: { path: ['source'], equals: 'crm' } }
}

export const CRM_SELLER_SELECT = {
  id: true, fullName: true, phone: true, additionalPhones: true, phoneDncFlags: true, address: true,
  neighborhood: true, city: true, status: true, metadata: true, priorListingStatus: true, priorListingPrice: true,
} as const satisfies Prisma.MojoContactSelect

export type CrmSellerRow = Prisma.MojoContactGetPayload<{ select: typeof CRM_SELLER_SELECT }>

// Enough to show 3 candidates and to tell one match from several.
const LOOKUP_TAKE = 10
const ORDER: Prisma.MojoContactOrderByWithRelationInput[] = [{ fullName: 'asc' }, { id: 'asc' }]

// take null: every row the filter matches (the address check below runs in code).
function lookup(organizationId: string, where: Prisma.MojoContactWhereInput, take: number | null = LOOKUP_TAKE) {
  return prisma.mojoContact.findMany({
    where: { AND: [crmSellerPoolWhere(organizationId), where] },
    select: CRM_SELLER_SELECT,
    orderBy: ORDER,
    ...(take !== null ? { take } : {}),
  })
}

// By name, case-insensitive: the exact name first (so "Jordan Sample" isn't
// also "Jordan Samples"), then the name as a phrase, then every word of it in
// any order ("Example Pat", "Pat Q Example"). Fewer than 3 letters looks up
// nobody: a one-letter "name" would be a search, not a named seller (D11).
export async function findSellersByName(name: string, organizationId: string): Promise<CrmSellerRow[]> {
  const clean = (name ?? '').replace(/\s+/g, ' ').trim()
  if (clean.replace(/[^a-z]/gi, '').length < 3) return []
  const exact = await lookup(organizationId, { fullName: { equals: clean, mode: 'insensitive' } })
  if (exact.length > 0) return exact
  const phrase = await lookup(organizationId, { fullName: { contains: clean, mode: 'insensitive' } })
  if (phrase.length > 0) return phrase
  const words = clean.toLowerCase().split(/[^a-z0-9']+/).filter(w => w.replace(/[^a-z]/g, '').length >= 2)
  if (words.length < 2) return []
  return lookup(organizationId, { AND: words.map(w => ({ fullName: { contains: w, mode: 'insensitive' as const } })) })
}

// A street address as house number + street words, via the CRM sync's own
// normalizer (case, punctuation, "# 3"/"Apt 4", 54th → 54, St/Ave spellings,
// Queens "88-14" → "8814"). Text after the first comma (city, state, ZIP) is
// dropped. null when there's no house number.
export function parseStreetAddress(raw: string | null | undefined): { house: string; street: string[] } | null {
  const norm = normalizeStreet((raw ?? '').split(',')[0])
  if (!norm) return null
  const [house, ...street] = norm.split(' ')
  return /^\d+[a-z]?$/.test(house) && street.length > 0 ? { house, street } : null
}

// The house number must match exactly (88 is not 188, Q11). The street must
// match word for word, except that one side may leave off the street type, so
// "88 Example" finds "88 Example Ave" (and "88 Example St": both come back as
// candidates to choose from).
export function sameStreetAddress(asked: string | null | undefined, stored: string | null | undefined): boolean {
  const a = parseStreetAddress(asked)
  const b = parseStreetAddress(stored)
  if (!a || !b || a.house !== b.house) return false
  const n = Math.min(a.street.length, b.street.length)
  return a.street.slice(0, n).join(' ') === b.street.slice(0, n).join(' ')
}

// Street words that are spelled several ways in stored addresses (St/Street,
// W/West, Ft/Fort), so they can't narrow the database query; the exact check
// in code covers them.
const SPELLED_MANY_WAYS = new Set([
  'st', 'str', 'street', 'ave', 'av', 'avenue', 'pl', 'place', 'rd', 'road', 'dr', 'drive', 'blvd', 'boulevard',
  'pkwy', 'parkway', 'ct', 'court', 'ln', 'lane', 'ter', 'terrace', 'hwy', 'highway', 'sq', 'square', 'ft', 'fort',
  'mt', 'mount', 'n', 's', 'e', 'w', 'north', 'south', 'east', 'west', 'saint',
])

// By street address over every seller: the database narrows by the house
// number's leading digits and one street word, then the exact rule above decides.
export async function findSellersByAddress(address: string, organizationId: string): Promise<CrmSellerRow[]> {
  const line = (address ?? '').split(',')[0].trim()
  const asked = parseStreetAddress(line)
  const digits = line.match(/^\d+/)?.[0]
  if (!asked || !digits) return []
  const word = line.toLowerCase().split(/[^a-z0-9]+/).slice(1)
    .map(w => w.replace(/^(\d+)(st|nd|rd|th)$/, '$1'))
    .find(w => w.length >= 2 && !SPELLED_MANY_WAYS.has(w))
  const rows = await lookup(organizationId, {
    AND: [
      { address: { startsWith: digits } },
      ...(word ? [{ address: { contains: word, mode: 'insensitive' as const } }] : []),
    ],
  }, null)
  return rows.filter(r => sameStreetAddress(line, r.address))
}

// Neighborhood (any spelling) or borough, for counts. A neighborhood matches its
// canonical name and every known variant ("Bed-Stuy", "bed stuy"); a borough
// matches the property city or any of its neighborhoods (Manhattan's city is
// "New York").
function areaWhere(area: string): Prisma.MojoContactWhereInput {
  const borough = BOROUGHS.find(b => b.toLowerCase() === area.trim().toLowerCase())
  if (borough) {
    const cities = borough === 'Manhattan' ? ['Manhattan', 'New York'] : [borough]
    const hoods = Object.values(NEIGHBORHOODS).filter(m => m.borough === borough).map(m => m.canonical)
    return { OR: [...cities.map(c => ({ city: { equals: c, mode: 'insensitive' as const } })), { neighborhood: { in: hoods } }] }
  }
  const canonical = fromRaw(area)
  const names = canonical ? [canonical, ...(NEIGHBORHOODS[canonical]?.variants ?? [])] : [area.trim()]
  return { OR: [...new Set(names)].map(n => ({ neighborhood: { equals: n, mode: 'insensitive' as const } })) }
}

// The area's display name: the canonical neighborhood, the borough, or as typed.
export function areaLabel(area: string | null | undefined): string | null {
  const a = (area ?? '').trim()
  if (!a) return null
  return BOROUGHS.find(b => b.toLowerCase() === a.toLowerCase()) ?? fromRaw(a) ?? a
}

// A database count over the whole pool (counts are fine under D11, S-02).
export function countCrmSellers(organizationId: string, area?: string | null): Promise<number> {
  const a = (area ?? '').trim()
  return prisma.mojoContact.count({ where: a ? { AND: [crmSellerPoolWhere(organizationId), areaWhere(a)] } : crmSellerPoolWhere(organizationId) })
}

const meta = (row: Pick<CrmSellerRow, 'metadata'>) => (row.metadata ?? {}) as Record<string, unknown>

// "Do not contact" when any of these says so [D11, Ryan 2026-10-18: opted-out
// sellers are marked]: a phone's do-not-call flag (any phone, when in doubt
// [engineering precaution]); the CRM's own opt-out list (metadata.crmOptOut,
// written by the morning sync, lib/crm-sync/mapLead.ts markOptOut); or opt-out
// wording in the latest or the first call result.
export function doNotContact(row: Pick<CrmSellerRow, 'phoneDncFlags' | 'metadata' | 'status'>): boolean {
  const m = meta(row)
  return (row.phoneDncFlags ?? []).some(Boolean)
    || m.crmOptOut === true
    || isOptOutWording(typeof m.lastCallResult === 'string' ? m.lastCallResult : null)
    || isOptOutWording(row.status)
}

export function toSellerCard(row: CrmSellerRow): SellerCard {
  const m = meta(row)
  return {
    kind: 'crm_seller',
    id: row.id,
    name: row.fullName,
    phone: formatPhone(row.phone ?? row.additionalPhones?.[0] ?? null),
    address: row.address ?? null,
    neighborhood: row.neighborhood ?? null,
    // The sync keeps status as the first call result it saw and the latest in metadata.
    lastCallResult: (typeof m.lastCallResult === 'string' ? m.lastCallResult : null) ?? row.status ?? null,
    status: row.status ?? null,
    doNotContact: doNotContact(row),
    crmUrl: crmLeadUrl(row.metadata),
  }
}

export function toSellerCandidate(row: CrmSellerRow): SellerCandidate {
  return { kind: 'crm_seller', id: row.id, name: row.fullName, neighborhood: row.neighborhood ?? null }
}
