import type { ScoredRecord, QueryPlan } from './types'

type Grade = ScoredRecord['grade']

// Pure logic — no LLM. Grades each record against the query plan.
// exact_match: all key criteria met
// close_match: off on one criterion (adjacent neighborhood, ±1 bed, within 25% price)
// weak_match:  off on two criteria
// irrelevant:  doesn't match on any key criterion

export function gradeRecords(records: ScoredRecord[], plan: QueryPlan): ScoredRecord[] {
  return records.map(r => ({ ...r, grade: gradeOne(r, plan) }))
}

function gradeOne(r: ScoredRecord, plan: QueryPlan): Grade {
  const { filters, adjacentNeighborhoods } = plan
  let misses = 0

  // ── Neighborhood check ────────────────────────────────────────────────────
  if (filters.neighborhoods.length > 0 && r.neighborhood) {
    const rn = r.neighborhood.toLowerCase()
    const exactMatch = filters.neighborhoods.some(n => rn.includes(n.toLowerCase()))
    if (!exactMatch) {
      const allAdjacent = Object.values(adjacentNeighborhoods).flat()
      const adjacentMatch = allAdjacent.some(n => rn.includes(n.toLowerCase()))
      if (!adjacentMatch) misses++
    }
  }

  // ── Borough check (only when no neighborhood filter) ──────────────────────
  if (filters.neighborhoods.length === 0 && filters.boroughs.length > 0 && r.borough) {
    const rb = r.borough.toLowerCase()
    const boroughMatch = filters.boroughs.some(b => rb.includes(b.toLowerCase()))
    if (!boroughMatch) misses++
  }

  // ── Beds check ────────────────────────────────────────────────────────────
  const rb = r.beds
  if (rb !== null) {
    if (filters.minBeds !== null && rb < filters.minBeds - 1) misses++
    else if (filters.maxBeds !== null && rb > filters.maxBeds + 1) misses++
  }

  // ── Price check ───────────────────────────────────────────────────────────
  const effectivePrice = r.price ?? r.maxPrice ?? r.minPrice
  if (effectivePrice !== null) {
    if (filters.maxPrice !== null && effectivePrice > filters.maxPrice * 1.25) misses++
    if (filters.minPrice !== null && effectivePrice < filters.minPrice * 0.75) misses++
  }

  // ── Grade by miss count ───────────────────────────────────────────────────
  if (misses === 0) return 'exact_match'
  if (misses === 1) return 'close_match'
  if (misses === 2) return 'weak_match'
  return 'irrelevant'
}

// Remove irrelevant records before sending to GPT
export function filterGraded(records: ScoredRecord[]): ScoredRecord[] {
  return records.filter(r => r.grade !== 'irrelevant')
}
