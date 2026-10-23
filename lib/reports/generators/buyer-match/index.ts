// Brief 27.0 — Buyer Match (M-02) generator: full-report coordinator + single-
// section (fragment) path. Full report = run all 8 sections in parallel. Fragment
// = run exactly one by key. Both share gatherContext (buyer eager, matches lazy).
import type { PrismaClient } from '@prisma/client'
import type Anthropic from '@anthropic-ai/sdk'
import type { GenContext, SectionResult, SectionRunner, GeneratedReport } from '../types'
import { renderMarkdown, collectSources } from '../render'
import { getTemplate } from '../../templates'
import { gatherContext } from './context'
import { criteriaLine } from './sections/_format'

import { criteriaSection } from './sections/criteria'
import { matchingInventorySection } from './sections/matching-inventory'
import { curatedMatchesSection } from './sections/curated-matches'
import { nearMissesSection } from './sections/near-misses'
import { offMarketSection } from './sections/off-market'
import { budgetRealitySection } from './sections/budget-reality'
import { showingScheduleSection } from './sections/showing-schedule'
import { recommendedAdjustmentSection } from './sections/recommended-adjustment'

// Ordered — drives full-report section order + markdown numbering. Keys MUST
// match the template's section keys (templates.ts SECTION_KEY_OVERRIDES['M-02']).
export const SECTION_RUNNERS: Record<string, SectionRunner> = {
  'criteria': criteriaSection,
  'matching-inventory': matchingInventorySection,
  'curated-matches': curatedMatchesSection,
  'near-misses': nearMissesSection,
  'off-market': offMarketSection,
  'budget-reality': budgetRealitySection,
  'showing-schedule': showingScheduleSection,
  'recommended-adjustment': recommendedAdjustmentSection,
}

const SECTION_ORDER = Object.keys(SECTION_RUNNERS)

export async function generateBuyerMatchReport({
  buyerId,
  prisma,
  anthropic,
  organizationId,
}: {
  buyerId: string
  prisma: PrismaClient
  anthropic?: Anthropic
  organizationId?: string // Brief 48 PR 13 (Q44): see gatherContext
}): Promise<GeneratedReport> {
  const ctx = await gatherContext({ buyerId, prisma, organizationId })

  const sections: SectionResult[] = await Promise.all(
    SECTION_ORDER.map(key => SECTION_RUNNERS[key](ctx, anthropic)),
  )

  const template = getTemplate('buyer-match')
  const subject = `${ctx.buyer.name} — ${new Date().toISOString().slice(0, 10)}`
  const markdown = renderMarkdown(sections, {
    title: template?.name ?? 'Buyer Match & Search Report',
    subtitle: `${subject} · ${criteriaLine(ctx.buyer)}`,
  })
  const sources = collectSources(sections)
  const matchCount = (await ctx.matches()).filter(m => m.tier === 'HOT').length

  return { sections, markdown, sources, subject, matchCount }
}

export async function generateBuyerMatchSection({
  sectionKey,
  buyerId,
  prisma,
  anthropic,
  organizationId,
}: {
  sectionKey: string
  buyerId: string
  prisma: PrismaClient
  anthropic?: Anthropic
  organizationId?: string
}): Promise<SectionResult> {
  const runner = SECTION_RUNNERS[sectionKey]
  if (!runner) {
    throw new Error(
      `buyer-match: unknown section "${sectionKey}". Valid sections: ${SECTION_ORDER.join(', ')}.`,
    )
  }
  const ctx = await gatherContext({ buyerId, prisma, organizationId })
  return runner(ctx, anthropic)
}
