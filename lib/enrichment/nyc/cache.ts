// Phase 4.6 — NycParcelCache read/write. Keyed on normalizedAddress (unique).
// Avoids hammering Socrata 12,100 times when many emails reference the same
// building. Rejections are cached too (an honest null + reason is worth keeping).
import { prisma } from '../../prisma'
import type { NycParcelCache } from '@prisma/client'

export type CacheWrite = {
  normalizedAddress:   string
  organizationId:      string
  bbl?:                string | null
  bin?:                string | null
  borough?:            string | null
  geosearchConfidence?: number | null
  geosearchLabel?:     string | null
  latitude?:           number | null
  longitude?:          number | null
  bldgclass?:          string | null
  unitsRes?:           number | null
  unitsTotal?:         number | null
  yearBuilt?:          number | null
  plutoVersion?:       string | null
  hasCondoDecl?:       boolean | null
  propertyType:        string | null
  propertyTypeReason:  string
  confidence:          string
}

// Brief 41 (H8): the ownername column is never written or read (it stays in
// the schema until a later migration drops it; existing values are nulled by
// scripts/brief41-null-ownernames.ts with Ryan's OK).
export type CachedParcel = Omit<NycParcelCache, 'ownername'>

export async function readCache(normalizedAddress: string): Promise<CachedParcel | null> {
  return prisma.nycParcelCache.findUnique({
    where: { normalizedAddress },
    select: {
      id: true, normalizedAddress: true, organizationId: true, bbl: true, bin: true, borough: true,
      geosearchConfidence: true, geosearchLabel: true, latitude: true, longitude: true, bldgclass: true,
      unitsRes: true, unitsTotal: true, yearBuilt: true, plutoVersion: true, hasCondoDecl: true,
      propertyType: true, propertyTypeReason: true, confidence: true, fetchedAt: true, updatedAt: true,
    },
  })
}

export async function writeCache(data: CacheWrite): Promise<void> {
  const { normalizedAddress, ...rest } = data
  await prisma.nycParcelCache.upsert({
    where:  { normalizedAddress },
    create: { normalizedAddress, ...rest },
    update: rest,
  })
}
