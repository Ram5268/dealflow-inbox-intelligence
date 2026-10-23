import { isSellerMatchesCard, type MatchTier, type SellerMatchesCard } from '@/lib/chat/sellerMatchesCard'
import { splitStoredCards } from './sellerCardView'

// Brief 43 PR 6: a stored chat reply keeps its matches card in dealsJson, tagged
// kind 'seller_matches' (app/api/chat/route.ts, no migration), next to PR 5's
// contact cards. The page splits both back out, so neither shows as a deal card.
export function splitStoredChatCards<T = unknown>(stored: unknown) {
  const all = Array.isArray(stored) ? stored : []
  return {
    ...splitStoredCards<T>(all.filter(x => !isSellerMatchesCard(x))),
    sellerMatches: all.filter(isSellerMatchesCard) as SellerMatchesCard[],
  }
}

// "Pat Example · Bedford-Stuyvesant": the seller's name and neighborhood only.
export function matchesTitle(card: Pick<SellerMatchesCard, 'seller'>): string {
  return [card.seller.name, card.seller.neighborhood].filter(Boolean).join(' · ')
}

// "3 matching buyers · 2 HOT · 1 WARM", the tiers as /matches labels them.
export function matchesHeadline(card: Pick<SellerMatchesCard, 'count' | 'tiers'>): string {
  const tiers = ([['HOT', card.tiers.hot], ['WARM', card.tiers.warm], ['POSSIBLE', card.tiers.possible]] as const)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${n} ${label}`)
  return [`${card.count} matching buyer${card.count === 1 ? '' : 's'}`, ...tiers].join(' · ')
}

// Shown only when the card lists fewer buyers than the seller has.
export function shownNote(card: Pick<SellerMatchesCard, 'count' | 'buyers'>): string | null {
  return card.count > card.buyers.length ? `Showing the top ${card.buyers.length} of ${card.count}.` : null
}

// The tier chip's colours, as on /matches (HOT red, WARM amber, POSSIBLE grey).
export function tierTone(tier: MatchTier): string {
  return tier === 'HOT' ? '#EF4444' : tier === 'WARM' ? '#F59E0B' : '#94A3B8'
}
