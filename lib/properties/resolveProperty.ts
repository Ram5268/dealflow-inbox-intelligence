import { prisma } from '../prisma'
import { normalizeAddress as canonicalNormalizeAddress } from '../domain/Address'

interface ResolveInput {
  address: string
  borough?: string | null
  zip?: string | null
  neighborhood?: string | null
  bbl?: string | null
}

interface ResolvedProperty {
  propertyId: string
  isNew: boolean
}

export async function resolveProperty(input: ResolveInput): Promise<ResolvedProperty | null> {
  const { address, borough, zip, neighborhood, bbl } = input
  if (!address || address.trim().length < 5) return null

  const normalized = canonicalNormalizeAddress(address)
  if (!normalized) return null

  // The Property.normalizedAddress column was written in uppercase by the
  // legacy lib/properties/normalizeAddress; upper-case here to keep
  // lookups matching existing rows. Phase E backfill will downcase the
  // column and this can become a straight `.normalized` reference.
  const normalizedFull = normalized.normalized.toUpperCase()
  const unitNumber     = normalized.unit

  // 1. Match by BBL if provided — most reliable NYC identifier
  if (bbl) {
    const byBbl = await prisma.property.findFirst({ where: { bbl } })
    if (byBbl) return { propertyId: byBbl.id, isNew: false }
  }

  // 2. Exact match on normalizedAddress
  const exact = await prisma.property.findFirst({
    where: { normalizedAddress: normalizedFull },
  })
  if (exact) return { propertyId: exact.id, isNew: false }

  // 3. Fuzzy match — normalizedFull is a substring of stored address or vice versa.
  //    Also filter by borough/zip when available to avoid cross-borough false matches.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fuzzyWhere: any = {
    OR: [
      { normalizedAddress: { contains: normalizedFull } },
      { normalizedAddress: { startsWith: normalized.streetNumber + ' ' } },
    ],
  }
  if (borough) fuzzyWhere.borough = { equals: borough, mode: 'insensitive' }
  if (zip) fuzzyWhere.zip = zip

  const fuzzy = await prisma.property.findFirst({ where: fuzzyWhere })
  if (fuzzy) return { propertyId: fuzzy.id, isNew: false }

  // 4. No match — create a new Property record
  const created = await prisma.property.create({
    data: {
      normalizedAddress: normalizedFull,
      unitNumber: unitNumber ?? undefined,
      neighborhood: neighborhood ?? undefined,
      borough: borough ?? undefined,
      zip: zip ?? undefined,
      bbl: bbl ?? undefined,
    },
  })

  return { propertyId: created.id, isNew: true }
}

// Convenience wrapper for when you only have a raw address string
export async function resolvePropertyFromString(
  address: string,
  opts?: { borough?: string | null; zip?: string | null; neighborhood?: string | null }
): Promise<string | null> {
  const result = await resolveProperty({ address, ...opts })
  return result?.propertyId ?? null
}
