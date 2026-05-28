import { parseQuery }                    from './queryParser'
import { buildQueryPlan }               from './queryPlanner'
import { structuredRetrieval, fetchRecentActive } from './structuredRetrieval'
import { hybridRetrieval }              from './hybridRetrieval'
import { gradeRecords, filterGraded }   from './documentGrader'
import { scoreRecords }                 from './matchScorer'
import { buildContext, buildShadowLog } from './contextBuilder'
import { needsDecomposition, decomposeQuery } from './queryDecomposer'
import type { ParsedQuery, QueryPlan, ScoredRecord } from './types'

export interface RetrievalResult {
  context:        string
  parsed:         ParsedQuery
  plan:           QueryPlan
  records:        ScoredRecord[]
  shadowLog:      object
  durationMs:     number
  decomposed?:    string[]      // sub-queries used, if decomposition fired
  error:          string | null // non-null = pipeline threw; null = genuine result (possibly empty)
}

// True when the query has no opportunity-relevant signals — e.g., "what do I have?"
// Vague queries skip embeddings/scoring and return the most recent active records.
export function isVague(p: ParsedQuery): boolean {
  return p.neighborhoods.length === 0
      && p.boroughs.length      === 0
      && p.categories.length    === 0
      && p.beds    === null && p.minBeds  === null && p.maxBeds  === null
      && p.minPrice === null && p.maxPrice === null
      && p.isRental === null
      && !p.isCalendar && !p.isACRIS && !p.isDOB
      && !p.isMyBuyer && !p.isSellerLead && !p.isEmailCampaign
}

function makeEmptyParsed(raw: string): ParsedQuery {
  return {
    raw,
    neighborhoods: [], boroughs: [],
    beds: null, minBeds: null, maxBeds: null,
    minUnits: null, maxUnits: null,
    minPrice: null, maxPrice: null,
    isRental: null,
    categories: [],
    intent: 'general',
    isCalendar: false, isACRIS: false, isDOB: false,
    isMyBuyer: false, isSellerLead: false, isEmailCampaign: false,
    broaden:   false,
    usedLLM: false,
    confidence: 0,
  }
}

function makeEmptyPlan(): QueryPlan {
  return {
    intent: 'general',
    searchCategories: [],
    excludeCategories: [],
    includeReviewQueue: false,
    filters: {
      neighborhoods: [], boroughs: [],
      minBeds: null, maxBeds: null,
      minUnits: null, maxUnits: null,
      minPrice: null, maxPrice: null,
      freshnessWindowDays: 90,
    },
    adjacentNeighborhoods: {},
    tools: [],
  }
}

// ── Single-query pipeline ─────────────────────────────────────────────────────
async function runSingleQuery(query: string): Promise<{
  parsed: ParsedQuery
  plan:   QueryPlan
  scored: ScoredRecord[]
}> {
  const parsed     = await parseQuery(query)
  const plan       = buildQueryPlan(parsed)
  const candidates = await structuredRetrieval(plan)
  const reranked   = await hybridRetrieval(query, candidates, plan)
  const graded     = gradeRecords(reranked, plan)
  const filtered   = graded.length >= 5 ? filterGraded(graded) : graded
  const scored     = scoreRecords(filtered, plan)
  return { parsed, plan, scored }
}

// ── Main retrieval pipeline ───────────────────────────────────────────────────
export async function runRetrieval(query: string): Promise<RetrievalResult> {
  const start = Date.now()

  try {
    // Step 1: Parse to check if decomposition is needed
    const parsed = await parseQuery(query)

    // Step 1b: Vague short-circuit — skip embeddings/scoring entirely.
    // Mirrors legacy `recentOpps` baseline so "what do I have?" never returns empty.
    if (isVague(parsed)) {
      const plan       = buildQueryPlan(parsed)
      const records    = await fetchRecentActive(25)
      const context    = buildContext(records, plan, query)
      const durationMs = Date.now() - start
      return {
        context,
        parsed,
        plan,
        records,
        shadowLog: { vagueShortCircuit: true, count: records.length, durationMs },
        durationMs,
        error:     null,
      }
    }

    // Step 2: Decompose if the query has multiple distinct intents
    if (needsDecomposition(query, parsed)) {
      const subQueries = await decomposeQuery(query)

      if (subQueries.length > 1 && subQueries[0] !== query) {
        // Run all sub-queries in parallel
        const subResults = await Promise.all(subQueries.map(q => runSingleQuery(q)))

        // Merge + deduplicate results across all sub-queries
        const seen    = new Set<string>()
        const merged: ScoredRecord[] = []
        for (const { scored } of subResults) {
          for (const r of scored) {
            if (!seen.has(r.id)) { seen.add(r.id); merged.push(r) }
          }
        }

        // Re-score merged set against the original query using the first sub-query's plan
        const primaryPlan = subResults[0].plan
        const rescored    = scoreRecords(merged, primaryPlan).slice(0, 25)
        const context     = buildContext(rescored, primaryPlan, query)
        const durationMs  = Date.now() - start

        return {
          context,
          parsed,
          plan:       primaryPlan,
          records:    rescored,
          shadowLog:  buildShadowLog(rescored, primaryPlan, query, durationMs),
          durationMs,
          decomposed: subQueries,
          error:      null,
        }
      }
    }

    // Step 3: Single-query path (most queries)
    const plan       = buildQueryPlan(parsed)
    const candidates = await structuredRetrieval(plan)
    const reranked   = await hybridRetrieval(query, candidates, plan)
    const graded     = gradeRecords(reranked, plan)
    const filtered   = graded.length >= 5 ? filterGraded(graded) : graded
    const scored     = scoreRecords(filtered, plan)
    const context    = buildContext(scored, plan, query)
    const durationMs = Date.now() - start

    return {
      context,
      parsed,
      plan,
      records:   scored,
      shadowLog: buildShadowLog(scored, plan, query, durationMs),
      durationMs,
      error:     null,
    }
  } catch (err) {
    const durationMs = Date.now() - start
    const message    = err instanceof Error ? err.message : String(err)
    console.error('[runRetrieval] pipeline error:', message)
    return {
      context:    '',
      parsed:     makeEmptyParsed(query),
      plan:       makeEmptyPlan(),
      records:    [],
      shadowLog:  { error: message, durationMs },
      durationMs,
      error:      message,
    }
  }
}

export type { ParsedQuery, QueryPlan, ScoredRecord }
