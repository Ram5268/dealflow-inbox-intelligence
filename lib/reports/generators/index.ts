// Brief 27.0 — generator registry. Maps a template id to its full-report and
// single-section entry points. Phase 1a ships one generator (buyer-match); future
// briefs add a generator here and flip HAS_GENERATOR in templates.ts to unlock.
import type { PrismaClient } from '@prisma/client'
import type Anthropic from '@anthropic-ai/sdk'
import type { SectionResult, GeneratedReport } from './types'
import { generateBuyerMatchReport, generateBuyerMatchSection } from './buyer-match'

export type FullArgs = { prisma: PrismaClient; anthropic?: Anthropic } & Record<string, unknown>
export type SectionArgs = { sectionKey: string; prisma: PrismaClient; anthropic?: Anthropic } & Record<string, unknown>

export type Generator = {
  full: (args: FullArgs) => Promise<GeneratedReport>
  section: (args: SectionArgs) => Promise<SectionResult>
}

// Brief 48 PR 13 (Q44): organizationId scopes every read, and the buyer must
// belong to it. POST /api/reports passes the current organization after the
// request's params; Drift's report tool passes none, so the buyer's own is used
// (a value in its params can only name the buyer's own, or the buyer is "not found").
const orgOf = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

export const GENERATOR_REGISTRY: Record<string, Generator> = {
  'buyer-match': {
    full: ({ buyerId, prisma, anthropic, organizationId }) =>
      generateBuyerMatchReport({ buyerId: String(buyerId), prisma, anthropic, organizationId: orgOf(organizationId) }),
    section: ({ sectionKey, buyerId, prisma, anthropic, organizationId }) =>
      generateBuyerMatchSection({ sectionKey, buyerId: String(buyerId), prisma, anthropic, organizationId: orgOf(organizationId) }),
  },
}

export function getGenerator(templateId: string): Generator | undefined {
  return GENERATOR_REGISTRY[templateId]
}

export type { GeneratedReport, SectionResult } from './types'
