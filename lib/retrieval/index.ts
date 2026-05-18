import { parseQuery }         from './queryParser'
import { buildQueryPlan }     from './queryPlanner'
import { structuredRetrieval} from './structuredRetrieval'
import { hybridRetrieval }    from './hybridRetrieval'
import { gradeRecords, filterGraded } from './documentGrader'
import { scoreRecords }       from './matchScorer'
import { buildContext, buildShadowLog } from './contextBuilder'
import type { ParsedQuery, QueryPlan, ScoredRecord } from './types'

export interface RetrievalResult {
  context:     string   // formatted context string for GPT
  parsed:      ParsedQuery
  plan:        QueryPlan
  records:     ScoredRecord[]
  shadowLog:   object
  durationMs:  number
}

// ── Main retrieval pipeline ───────────────────────────────────────────────────
export async function runRetrieval(query: string): Promise<RetrievalResult> {
  const start = Date.now()

  // 1. Parse query (deterministic → LLM fallback)
  const parsed = await parseQuery(query)

  // 2. Build query plan
  const plan = buildQueryPlan(parsed)

  // 3. Structured retrieval (SQL-first, up to 40 candidates)
  const candidates = await structuredRetrieval(plan)

  // 4. Hybrid retrieval (vector search scoped to candidates)
  const reranked = await hybridRetrieval(query, candidates, plan)

  // 5. Grade documents (pure logic)
  const graded = gradeRecords(reranked, plan)

  // 6. Filter out irrelevant (only when we have enough results)
  const filtered = graded.length >= 5 ? filterGraded(graded) : graded

  // 7. Score with intent-specific profile
  const scored = scoreRecords(filtered, plan)

  // 8. Build context string
  const context = buildContext(scored, plan, query)

  const durationMs = Date.now() - start

  return {
    context,
    parsed,
    plan,
    records:   scored,
    shadowLog: buildShadowLog(scored, plan, query, durationMs),
    durationMs,
  }
}

export type { ParsedQuery, QueryPlan, ScoredRecord }
