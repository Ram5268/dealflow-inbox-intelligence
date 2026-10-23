// Brief 43 PR 14 (Q29, M21): the starter chips on the chat page, built from
// the counts app/api/chat/chips/route.ts reads. A chip only promises what
// Drift's search can do [engineering precaution]:
// - no price-drop chip: search has no price-drop category;
// - a time window ("last 24 hours") only on a chip whose count says something
//   came in, and search filters by that date (createdAfter);
// - the fallback chips, shown when nothing came in recently (email reading is
//   paused [Ryan, 2026-09-24]), ask for things search always answers.
// Feel standard (Brief 42 TEST_PLAN §3): no em-dash, no "!", no system words.

export type Chip = { label: string; query: string }

export interface ChipCounts {
  recent: number                 // anything new in the last 24 hours
  comingSoonOrOffMarket: number  // coming-soon and off-market sales, last 24 hours
  buyerISO: number               // buyer ISOs, last 48 hours
  rentalNew: number              // rental listings, last 48 hours
}

export const FALLBACK_CHIPS: Chip[] = [
  { label: 'Newest listings', query: 'Show me the newest listings on file.' },
  { label: 'Coming soon listings', query: 'Show me all coming soon listings in the database.' },
  { label: 'Buyer ISO matches', query: 'Show me all buyer ISOs and check if any match my current listings.' },
  { label: 'Off-market deals', query: 'Show me all off-market deals in my inbox.' },
]

export function buildChips(c: ChipCounts): Chip[] {
  const chips: Chip[] = []

  // Always lead with what came in recently
  if (c.recent > 0) {
    chips.push({ label: `${c.recent} new in the last 24 hours`, query: 'What came in over the last 24 hours? Summarize it.' })
  }
  if (c.comingSoonOrOffMarket > 0) {
    chips.push({ label: `${c.comingSoonOrOffMarket} coming soon & off-market`, query: 'Show me the coming soon listings and off-market deals from the last 24 hours.' })
  }
  if (c.buyerISO > 0) {
    chips.push({
      label: `${c.buyerISO} buyer ISO${c.buyerISO > 1 ? 's' : ''} to match`,
      query: 'Show me the buyer ISOs from the last 48 hours. What are they looking for, and do any match my listings?',
    })
  }
  if (c.rentalNew > 0) {
    chips.push({ label: `${c.rentalNew} new rental${c.rentalNew > 1 ? 's' : ''}`, query: 'Show me the new rental listings from the last 48 hours.' })
  }

  // Fallback chips if the database is empty or nothing is recent; cap at 4.
  return (chips.length === 0 ? FALLBACK_CHIPS : chips).slice(0, 4)
}
