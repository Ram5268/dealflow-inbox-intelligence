import type { ScoredRecord, QueryPlan } from './types'

const MAX_RECORDS = 15
const ATTACHMENT_SCORE_THRESHOLD = 70

function formatPrice(r: ScoredRecord): string {
  if (r.price)    return `$${r.price.toLocaleString()}`
  if (r.minPrice && r.maxPrice) return `$${r.minPrice.toLocaleString()}–$${r.maxPrice.toLocaleString()}`
  if (r.minPrice) return `from $${r.minPrice.toLocaleString()}`
  if (r.maxPrice) return `up to $${r.maxPrice.toLocaleString()}`
  return 'price TBD'
}

function formatBeds(r: ScoredRecord): string {
  if (r.beds === 0) return 'Studio'
  if (r.beds)       return `${r.beds}BR`
  return ''
}

function tierLabel(r: ScoredRecord): string {
  switch (r.tier) {
    case 'excellent': return `EXCELLENT:${r.score}`
    case 'good':      return `GOOD:${r.score}`
    case 'fair':      return `FAIR:${r.score}`
    default:          return `FAIR:${r.score}`
  }
}

function formatOneLiner(r: ScoredRecord): string {
  const parts = [
    r.address ?? r.extractedTitle ?? r.neighborhood ?? '(no address)',
    formatPrice(r),
    formatBeds(r),
    r.neighborhood ?? r.borough ?? '',
    r.availabilityDate ? `avail ${r.availabilityDate}` : '',
  ].filter(Boolean)

  const agentLine = r.sourceAgentName
    ? ` | ${r.sourceAgentName}${r.sourceBrokerage ? ` @ ${r.sourceBrokerage}` : ''}`
    : ''

  return `[${tierLabel(r)}] [${r.id}] ${parts.join(' — ')}${agentLine}`
}

export function buildContext(records: ScoredRecord[], plan: QueryPlan, rawQuery: string): string {
  // Take top N, excluding weak records if we have enough good ones
  const top = records.slice(0, MAX_RECORDS)
  if (top.length === 0) return ''

  const lines: string[] = [
    `DATABASE (${top.length} results, scored for: ${rawQuery}):`,
    `Intent: ${plan.intent} | Neighborhoods: ${plan.filters.neighborhoods.join(', ') || 'any'} | Beds: ${plan.filters.minBeds ?? ''}${plan.filters.maxBeds !== null ? '–' + plan.filters.maxBeds : ''} | Price: ${plan.filters.minPrice ? '$' + plan.filters.minPrice.toLocaleString() : ''}–${plan.filters.maxPrice ? '$' + plan.filters.maxPrice.toLocaleString() : ''}`,
    '',
  ]

  // Group by tier for cleaner output
  const byTier = {
    excellent: top.filter(r => r.tier === 'excellent'),
    good:      top.filter(r => r.tier === 'good'),
    fair:      top.filter(r => r.tier === 'fair'),
    weak:      top.filter(r => r.tier === 'weak'),
  }

  for (const [tierName, group] of Object.entries(byTier)) {
    if (group.length === 0) continue
    for (const r of group) {
      lines.push(formatOneLiner(r))

      // Full summary for good+ records
      if (r.tier === 'excellent' || r.tier === 'good') {
        if (r.extractedSummary) lines.push(`  → ${r.extractedSummary}`)
      }

      // (Attachment text is included by the existing pipeline via rawEmail join)
    }
    if (tierName !== 'weak') lines.push('')
  }

  return lines.join('\n')
}

// Shadow log format — for comparing new vs old pipeline in logs
export function buildShadowLog(
  records: ScoredRecord[],
  plan:    QueryPlan,
  rawQuery: string,
  durationMs: number,
): object {
  return {
    query:        rawQuery,
    intent:       plan.intent,
    neighborhoods: plan.filters.neighborhoods,
    usedLLM:      false,
    totalCandidates: records.length,
    topScores:    records.slice(0, 5).map(r => ({ id: r.id, score: r.score, tier: r.tier, grade: r.grade, category: r.category })),
    durationMs,
  }
}
