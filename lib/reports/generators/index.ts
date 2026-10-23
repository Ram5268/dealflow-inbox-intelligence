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
// belong to it. POST /api/reports and Drift's report tools pass the current
// organization after the request's params, so a param can't change it. With
// none (scripts, tests), the buyer's own organization is used.
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
