// The daily sweep's date rules (sweepDateExpirations in lib/streetEasySync.ts),
// kept in one place so the sweep and the miss-delisting repair
// (lib/streetEasyMissRepair.ts) apply exactly the same rules. Pure: no DB.
//
// For a listing that is 'active':
// - an open house or a showing goes 'stale' once its date has passed;
// - a coming-soon sale or rental goes 'stale' 30 days after its date: it was
//   never upgraded to an active listing, so assume it fell through or was
//   already handled;
// - a sale, rental, off-market, back-on-market or price-drop listing more
//   than 90 days old that StreetEasy has never checked goes to 'needs_review',
//   not 'stale'.
//
// availabilityDate is text ("YYYY-MM-DD" from the extractors). As in the
// sweep's SQL, it is compared as text with an ISO timestamp.

const DAY_MS = 86_400_000

export const PAST_EVENT_CATEGORIES: readonly string[] = ['OPEN_HOUSE', 'SHOWING_CONFIRMATION']
export const COMING_SOON_EXPIRY_CATEGORIES: readonly string[] = ['COMING_SOON_SALE', 'COMING_SOON_RENTAL']
export const COMING_SOON_GRACE_DAYS = 30
export const AGED_REVIEW_CATEGORIES: readonly string[] = [
  'ACTIVE_SALE_LISTING', 'RENTAL_LISTING', 'OFF_MARKET_SALE', 'BACK_ON_MARKET', 'PRICE_DROP',
]
export const AGED_REVIEW_DAYS = 90

export interface DateExpiryCutoffs {
  pastEventBefore: string  // an open house or showing dated before this has passed
  comingSoonBefore: string // a coming-soon dated before this is 30+ days past its date
  agedBefore: Date         // a listing created before this is 90+ days old
}

export function dateExpiryCutoffs(now: Date): DateExpiryCutoffs {
  return {
    pastEventBefore: now.toISOString(),
    comingSoonBefore: new Date(now.getTime() - COMING_SOON_GRACE_DAYS * DAY_MS).toISOString(),
    agedBefore: new Date(now.getTime() - AGED_REVIEW_DAYS * DAY_MS),
  }
}

export interface DateExpiryRow {
  category: string
  availabilityDate: string | null
  streetEasyCheckedAt: Date | null
  createdAt: Date
}

// What the sweep's date rules would do to this listing if it were active:
// 'stale', 'needs_review', or null (nothing).
export function dateExpiryFor(row: DateExpiryRow, now: Date): 'stale' | 'needs_review' | null {
  const cut = dateExpiryCutoffs(now)
  const date = row.availabilityDate
  if (PAST_EVENT_CATEGORIES.includes(row.category) && date !== null && date < cut.pastEventBefore) return 'stale'
  if (COMING_SOON_EXPIRY_CATEGORIES.includes(row.category) && date !== null && date < cut.comingSoonBefore) return 'stale'
  if (AGED_REVIEW_CATEGORIES.includes(row.category) && row.streetEasyCheckedAt === null && row.createdAt < cut.agedBefore) return 'needs_review'
  return null
}
