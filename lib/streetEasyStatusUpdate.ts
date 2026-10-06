// Brief 41 (H5) — what a StreetEasy status check writes to a listing. Pure (no
// DB, no network). A listing is marked delisted or sold only when StreetEasy
// itself says so. Not finding it proves nothing: off-market and coming-soon
// listings aren't on StreetEasy, and a missing RAPIDAPI_KEY, a 429, the monthly
// quota or any API error also come back as "not found". Every miss used to mark
// the listing delisted + stale, which hid it from Drift's search and the buyer
// report.

export interface SEStatusListing {
  id: string
  status: string
  url?: string
}

// ── Map SE status to our processingStatus ────────────────────────────────────
// Observed API status vocabulary (audited 2026-05-28 against /sales/{id} and
// /rentals/{id}): 'open' (active listings — most common), 'closed' (rental
// off-market / sale withdrawn or sold), 'sold' (sale completed; also used
// loosely for rentals where lease was signed), 'temporary_off_market'
// (surfaced from the default-fallback warning during the X.4 catch-up
// sweep — semantically off-market with possible relisting later).
// Defensive cases below cover plausible variants we haven't observed yet
// ('active', 'available', 'new', 'pending', 'in contract', 'withdrawn', etc.)
// in case the API vocabulary expands. Unrecognized strings warn-log so we
// catch new states before they pollute streetEasyStatus at scale.
export function mapStatus(seStatus: string): { streetEasyStatus: string; processingStatus?: string } {
  switch (seStatus?.toLowerCase()) {
    case 'open':
    case 'active':
    case 'available':
    case 'new':
      return { streetEasyStatus: 'active' }
    case 'pending':
    case 'in contract':
    case 'contract signed':
    case 'in_contract':
      return { streetEasyStatus: 'in_contract' }
    case 'closed':
    case 'delisted':
    case 'off market':
    case 'off_market':
    case 'temporary_off_market':
    case 'withdrawn':
    case 'cancelled':
    case 'rented':
    case 'leased':
    case 'no_longer_available':
      return { streetEasyStatus: 'delisted', processingStatus: 'stale' }
    case 'sold':
      return { streetEasyStatus: 'sold', processingStatus: 'stale' }
    default:
      console.warn(`[mapStatus] unrecognized SE status: "${seStatus}" — defaulting to 'unknown'. Consider adding to the case map.`)
      return { streetEasyStatus: 'unknown' }
  }
}

export interface StatusUpdate {
  streetEasyCheckedAt: Date
  streetEasyId?: string
  streetEasyStatus?: string
  processingStatus?: string
}

// The fields to write after a check. No listing found: only the check time,
// so the listing keeps its status and the sweep moves on to other listings.
export function statusUpdateFor(listing: SEStatusListing | null, now: Date): StatusUpdate {
  if (!listing) return { streetEasyCheckedAt: now }
  const { streetEasyStatus, processingStatus } = mapStatus(listing.status)

  // Prefer the URL path from the API (e.g. "building/newswalk-phase-3/204")
  // over constructing one from the numeric ID — named developments need the slug form.
  let streetEasyId = listing.id
  if (listing.url) {
    const m = listing.url.match(/streeteasy\.com\/(.+?)(?:\?.*)?$/)
    if (m) streetEasyId = m[1].replace(/\/$/, '')
  }
  return { streetEasyId, streetEasyStatus, streetEasyCheckedAt: now, ...(processingStatus ? { processingStatus } : {}) }
}
