// Brief 43 PR 9 (Q15, Q41): search_parties' name/description filter and its
// buyer-type (archetype) filter, kept pure so they can be tested on their own.
//
// - query: a buyer's or renter's name, their agent's name, or words from the
//   request ("Ridgewood two-family"). Every word must appear as a whole word in
//   one field (the request's title, the agent's name, or a CRM buyer's name),
//   so "Chen" never matches "kitchen" and an unknown name finds nothing. The
//   database narrows with `contains`; the whole-word check runs after.
// - archetype: the stored buyer type (lib/matching archetypes, the
//   ExtractedOpportunity.buyerArchetype column). Inbox extraction doesn't fill
//   that column, so a request with none stored also counts when it names the
//   type in unmistakable words ("1031", "FHA"). A stored type always wins.
// All of this is for Q15/Q41 [engineering precaution], not a rule of Ryan's.
import type { Prisma } from '@prisma/client'

// Plain words for the card (no system codes in what Drift reads out), and the
// unmistakable words a request may use for the type.
export const BUYER_ARCHETYPES = {
  CASH_BUYER: { label: 'all cash', mentions: [] },
  EXCHANGE_1031: { label: '1031 exchange', mentions: ['1031'] },
  TRADITIONAL_FINANCING: { label: 'financed', mentions: [] },
  INVESTOR_LANDLORD: { label: 'investor or landlord', mentions: [] },
  FIRST_TIME_FHA: { label: 'first-time buyer (FHA)', mentions: ['fha'] },
  LUXURY_ALL_CASH: { label: 'luxury, all cash', mentions: [] },
  LUXURY_FINANCED: { label: 'luxury, financed', mentions: [] },
} as const satisfies Record<string, { label: string; mentions: readonly string[] }>

export type BuyerArchetype = keyof typeof BUYER_ARCHETYPES
export const BUYER_ARCHETYPE_CODES = Object.keys(BUYER_ARCHETYPES) as [BuyerArchetype, ...BuyerArchetype[]]

export function archetypeLabel(code: string | null | undefined): string | null {
  return code && code in BUYER_ARCHETYPES ? BUYER_ARCHETYPES[code as BuyerArchetype].label : null
}

// "two-family" and "2-family" are the same words: number words two to nine
// read as digits, in the query and the fields alike (and in the database below).
const NUMBER_WORDS: Record<string, string> = { two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' }
const DIGIT_WORDS: Record<string, string> = Object.fromEntries(Object.entries(NUMBER_WORDS).map(([w, d]) => [d, w]))

// Lowercased words, letters and digits only, in any script. A possessive "'s"
// goes first ("Pat's buyer" is Pat's), so it isn't a word of its own.
const words = (s: string | null | undefined): string[] => (s ?? '').toLowerCase().replace(/['\u2019]s\b/g, '')
  .split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(w => NUMBER_WORDS[w] ?? w)

// Words that say nothing about which buyer ("the buyer", "my client", "the
// Example lead", "Pat's search").
const FILLER = new Set(['a', 'an', 'the', 'my', 'for', 'of', 'buyer', 'buyers', 'renter', 'renters', 'client', 'named',
  'lead', 'search'])

// At most this many distinct words count, which keeps the database query small.
export const MAX_QUERY_WORDS = 8

export const queryWords = (query: string | null | undefined): string[] =>
  [...new Set(words(query).filter(w => !FILLER.has(w)))].slice(0, MAX_QUERY_WORDS)

// Every word appears as a whole word in at least one of the fields.
export function fieldHasAllWords(fields: Array<string | null | undefined>, want: string[]): boolean {
  return want.length > 0 && fields.some(f => {
    const have = new Set(words(f))
    return want.every(w => have.has(w))
  })
}

// A request with no stored type that names `code` in unmistakable words.
export function mentionsArchetype(code: BuyerArchetype, texts: Array<string | null | undefined>): boolean {
  const mentions: readonly string[] = BUYER_ARCHETYPES[code].mentions
  return mentions.length > 0 && texts.some(t => words(t).some(w => mentions.includes(w)))
}

// Typed against Prisma's where input, so a misspelt column fails tsc.
type TextField = Extract<keyof Prisma.ExtractedOpportunityWhereInput, 'extractedTitle' | 'sourceAgentName' | 'extractedSummary'>
const has = (field: TextField, w: string): Prisma.ExtractedOpportunityWhereInput =>
  DIGIT_WORDS[w]
    ? { OR: [w, DIGIT_WORDS[w]].map(x => ({ [field]: { contains: x, mode: 'insensitive' } })) }
    : { [field]: { contains: w, mode: 'insensitive' } }

// The database side of both filters, for the inbox buyer/renter query. Broad on
// purpose (substring); fieldHasAllWords / mentionsArchetype make it exact.
export function partyFilterWhere(query: string[] | null, archetype: BuyerArchetype | null): Prisma.ExtractedOpportunityWhereInput[] {
  const and: Prisma.ExtractedOpportunityWhereInput[] = []
  if (query) and.push({ OR: (['extractedTitle', 'sourceAgentName'] as const).map(f => ({ AND: query.map(w => has(f, w)) })) })
  if (archetype) {
    const mentions: readonly string[] = BUYER_ARCHETYPES[archetype].mentions
    and.push({
      OR: [
        { buyerArchetype: archetype },
        ...(mentions.length > 0
          ? [{ buyerArchetype: null, OR: mentions.flatMap(w => [has('extractedTitle', w), has('extractedSummary', w)]) }]
          : []),
      ],
    })
  }
  return and
}
