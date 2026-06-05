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
  ownername?:          string | null
  unitsRes?:           number | null
  unitsTotal?:         number | null
  yearBuilt?:          number | null
  plutoVersion?:       string | null
  hasCondoDecl?:       boolean | null
  propertyType:        string | null
  propertyTypeReason:  string
  confidence:          string
}

export async function readCache(normalizedAddress: string): Promise<NycParcelCache | null> {
  return prisma.nycParcelCache.findUnique({ where: { normalizedAddress } })
}

export async function writeCache(data: CacheWrite): Promise<void> {
  const { normalizedAddress, ...rest } = data
  await prisma.nycParcelCache.upsert({
    where:  { normalizedAddress },
    create: { normalizedAddress, ...rest },
    update: rest,
  })
}
