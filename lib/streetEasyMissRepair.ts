// Brief 41 (H5): which listings to restore after the old StreetEasy lookup
// marked them delisted on a miss (no StreetEasy id). Pure, so it is unit-tested;
// scripts/brief41-undo-miss-delistings.ts reads the rows and applies it.
//
// - Every such row loses the false streetEasyStatus='delisted' (it hides a row
//   from Drift's structured search whatever its processingStatus).
// - Its processingStatus is put back only if the miss made it 'stale' and Ryan
//   hasn't decided otherwise: never for a duplicate, never if a review item was
//   rejected or marked duplicate/stale. A row still waiting in the review queue
//   goes back to 'needs_review', not 'active'.

export interface MissDelistedRow {
  id: string
  processingStatus: string
  isDuplicate: boolean
}

export interface ReviewItemRef {
  opportunityId: string | null
  status: string
}

export interface MissRepairPlan {
  clearStatus: string[]
  toActive: string[]
  toNeedsReview: string[]
  keptByDecision: string[] // duplicate, or rejected / marked duplicate or stale in review
}

const DECIDED = new Set(['rejected', 'marked_duplicate', 'marked_stale'])

export function planMissRepair(rows: MissDelistedRow[], reviewItems: ReviewItemRef[]): MissRepairPlan {
  const plan: MissRepairPlan = { clearStatus: [], toActive: [], toNeedsReview: [], keptByDecision: [] }
  const itemsFor = new Map<string, string[]>()
  for (const item of reviewItems) {
    if (!item.opportunityId) continue
    itemsFor.set(item.opportunityId, [...(itemsFor.get(item.opportunityId) ?? []), item.status])
  }
  for (const row of rows) {
    plan.clearStatus.push(row.id)
    const statuses = itemsFor.get(row.id) ?? []
    if (row.isDuplicate || statuses.some((s) => DECIDED.has(s))) {
      plan.keptByDecision.push(row.id)
      continue
    }
    if (row.processingStatus !== 'stale') continue
    if (statuses.includes('pending')) plan.toNeedsReview.push(row.id)
    else plan.toActive.push(row.id)
  }
  return plan
}
