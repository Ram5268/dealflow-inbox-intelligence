import { isSellerCard, type SellerCard } from '@/lib/chat/sellerCard'

// Brief 43 PR 5: a stored chat reply keeps its seller cards in dealsJson,
// tagged kind 'crm_seller' (app/api/chat/route.ts, no migration). The page
// splits them back out so they render as seller cards, never as deal cards.
export function splitStoredCards<T = unknown>(stored: unknown): { deals: T[]; sellerCards: SellerCard[] } {
  const all = Array.isArray(stored) ? stored : []
  return {
    deals: all.filter(x => !isSellerCard(x)) as T[],
    sellerCards: all.filter(isSellerCard),
  }
}

// The address line: street, then neighborhood ("88 Example Ave · Bedford-Stuyvesant").
export function sellerAddressLine(card: Pick<SellerCard, 'address' | 'neighborhood'>): string | null {
  return [card.address, card.neighborhood].filter(Boolean).join(' · ') || null
}
