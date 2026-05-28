// Single home for deterministic-vs-LLM reconciliation rules.
//
// Background: parseQuery returns a ParsedQuery whose `categories` come from
// a merge of two sources — the deterministic regex pass (detectCategorySignals)
// and an LLM fallback (gpt-4o-mini) that fires when deterministic confidence
// is low or a location-phrase is detected without a recognized neighborhood.
//
// The LLM occasionally hallucinates category tags that contradict the
// deterministic isRental flag — e.g. it sees the word "active" in a renter
// query ("anything active available?") and tags `ACTIVE_SALE_LISTING`. The
// historical fix lived inside `categoriesForIntent` in queryPlanner.ts.
//
// Phase C consolidates that rule here. Every place in the codebase that
// reads `parsed.categories` after the parse step should go through
// `reconcileIntent(parsed)` first. The rule "deterministic isRental wins
// over LLM-supplied category mismatches" lives in exactly one place.

import type { ParsedQuery } from './types'
import { Category } from '@prisma/client'
import { SUPPLY_SALE, SUPPLY_RENTAL } from '../domain/Categories'

export interface ReconciledIntent {
  // ParsedQuery's category and isRental signals, reconciled so deterministic
  // flags beat LLM hints when they conflict. Other fields on ParsedQuery
  // (neighborhoods, beds, price, intent) are not touched by reconciliation —
  // those don't have a deterministic-vs-LLM tension worth centralizing yet.
  categories: Category[]
  isRental:   boolean | null
}

const SALE_SET   = new Set<string>(SUPPLY_SALE)
const RENTAL_SET = new Set<string>(SUPPLY_RENTAL)

export function reconcileIntent(parsed: ParsedQuery): ReconciledIntent {
  const incoming = (parsed.categories ?? []) as readonly string[]

  // Rule 1: deterministic isRental wins over LLM-supplied category mismatches.
  // When isRental === true, no sale categories survive. When isRental === false,
  // no rental categories survive. When isRental === null (undetermined), the
  // LLM-supplied categories pass through untouched — we have no signal to
  // override them.
  const filtered = incoming.filter(c => {
    if (parsed.isRental === true  && SALE_SET.has(c))   return false
    if (parsed.isRental === false && RENTAL_SET.has(c)) return false
    return true
  })

  // (Future rules: add them here, each with a numbered comment + justification.
  //  Phase C ships with Rule 1 only. As new deterministic-vs-LLM conflicts are
  //  discovered, they should land in this file rather than at the call site.)

  return {
    categories: filtered as Category[],
    isRental:   parsed.isRental,
  }
}
