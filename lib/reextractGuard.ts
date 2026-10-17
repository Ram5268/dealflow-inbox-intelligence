// Brief 41.1 (PR H, review F12): re-extract (app/api/sync/reextract, behind
// the maintenance switch) replaces an email's saved listings with a fresh AI
// answer. An answer with no listings in it (only noise, irrelevant or
// malformed entries) would wipe them. So re-extract keeps the saved listings
// and reports it, unless the request sends "force": true. Pure: no DB.

// The categories and transaction types re-extract accepts (moved from the route).
export const REEXTRACT_CATEGORIES: ReadonlySet<string> = new Set([
  'COMING_SOON_SALE', 'OFF_MARKET_SALE', 'ACTIVE_SALE_LISTING', 'RENTAL_LISTING',
  'BUYER_ISO', 'RENTER_INQUIRY', 'SELLER_LEAD', 'LANDLORD_LEAD',
  'DEVELOPMENT_INVENTORY', 'OPEN_HOUSE', 'PRICE_DROP', 'BACK_ON_MARKET', 'NOISE',
])
export const REEXTRACT_TRANSACTION_TYPES: ReadonlySet<string> = new Set([
  'SALE', 'RENTAL', 'BUYER_NEED', 'RENTER_NEED', 'SELLER_LEAD', 'LANDLORD_LEAD', 'UNKNOWN',
])

// The entries of an AI answer that become listings: relevant, with a known
// category other than NOISE. Anything else is skipped, including an entry
// that isn't an object at all.
export function listingEntries<T>(results: readonly T[]): T[] {
  return results.filter((ext) => {
    if (typeof ext !== 'object' || ext === null) return false
    const { isRelevant, category } = ext as { isRelevant?: unknown; category?: unknown }
    return Boolean(isRelevant) && typeof category === 'string' && category !== 'NOISE' && REEXTRACT_CATEGORIES.has(category)
  })
}

// Only the JSON boolean true counts ("true", 1 or "yes" don't).
export function forceRequested(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { force?: unknown }).force === true
}

export interface SwapDecision {
  swap: boolean
  kept?: number  // saved listings left in place
  reason?: string
}

// Whether to replace an email's saved listings with the fresh ones.
export function reextractSwapDecision({ saved, fresh, force }: { saved: number; fresh: number; force: boolean }): SwapDecision {
  if (fresh > 0 || force) return { swap: true }
  if (saved > 0) {
    return {
      swap: false,
      kept: saved,
      reason: `kept the ${saved} saved listing(s): the new answer has none (only noise, irrelevant or malformed entries). Send "force": true to replace them anyway.`,
    }
  }
  return { swap: false, reason: 'no saved listings and none in the new answer: nothing to do' }
}
