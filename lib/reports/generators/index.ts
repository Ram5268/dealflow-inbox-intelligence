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

export const GENERATOR_REGISTRY: Record<string, Generator> = {
  'buyer-match': {
    full: ({ buyerId, prisma, anthropic }) =>
      generateBuyerMatchReport({ buyerId: String(buyerId), prisma, anthropic }),
    section: ({ sectionKey, buyerId, prisma, anthropic }) =>
      generateBuyerMatchSection({ sectionKey, buyerId: String(buyerId), prisma, anthropic }),
  },
}

export function getGenerator(templateId: string): Generator | undefined {
  return GENERATOR_REGISTRY[templateId]
}

export type { GeneratedReport, SectionResult } from './types'
