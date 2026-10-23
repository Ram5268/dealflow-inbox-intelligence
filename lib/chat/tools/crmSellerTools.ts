// Brief 43 PR 5: dispatch for the two CRM-seller tools (find_seller,
// count_sellers), kept out of app/api/chat/route.ts so the route only routes.
//   output    the full result, for the guard's grounding and PR 3's draft check
//             (a seller card is any object with kind 'crm_seller')
//   forModel  what Drift reads back (no CRM link, see findSellerForModel)
//   card      the seller card the page shows, when there is exactly one match
// Brief 43 PR 6 adds the matches tools: get_seller_matches (one named seller's
// buyers; Drift reads them without the /matches links, getSellerMatchesForModel),
// count_matches and count_sellers_with_buyers (counts only).
//   matchesCard  that seller's buyers, as the card the page shows
// Brief 43 PR 12 (D9: Brief 42 default D9, restated in Brief 46 §4.2): `output` and
// `forModel` carry our internal estimate and the prior listing; `card` and
// `matchesCard` (sent to the page and stored with the reply) never do: our values
// stay out of anything a buyer or homeowner could see [Ryan, 2026-10-17].
import { findSeller, findSellerForModel, type FindSellerInput, type FindSellerResult } from './findSeller'
import { countSellers, type CountSellersInput } from './countSellers'
import { getSellerMatchesForModel, loadSellerMatches, sellerOf, type GetSellerMatchesInput, type GetSellerMatchesResult } from './sellerMatches'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { countMatches, countSellersWithBuyers, type CountMatchesInput } from './countMatches'
import type { SellerCard } from '@/lib/chat/sellerCard'
import type { SellerMatchesCard } from '@/lib/chat/sellerMatchesCard'
import { withoutPriceFacts } from '@/lib/chat/valuation'

export const CRM_SELLER_TOOL_NAMES = new Set(['find_seller', 'count_sellers', 'get_seller_matches', 'count_matches', 'count_sellers_with_buyers'])

export interface CrmSellerToolRun {
  output: unknown
  forModel: unknown
  card: SellerCard | null
  matchesCard: SellerMatchesCard | null
  totalMatched: number
}

// One seller contact per message [engineering precaution; D11, Ryan 2026-10-18:
// "a specific seller contact"]. Without it, one turn could look up the 3
// candidates of a surname, or names from another result, and hand Ryan several
// contacts he never named. A second, different match in the same turn comes
// back as a name and neighborhood only, with a note; the same seller again is
// fine (by name, then by address).
export interface CrmSellerTurn { cardId: string | null }
export const newCrmSellerTurn = (): CrmSellerTurn => ({ cardId: null })
export const ONE_SELLER_PER_MESSAGE =
  'One seller contact per message: this one was not shown. Ask Ryan to ask for them by name in his next message.'

// Brief 43 PR 6: the same one-seller rule covers get_seller_matches, so a
// message shows one named seller's contact and/or buyers, never several
// sellers' (D11 [Ryan, 2026-10-18]; engineering precaution). The same check as
// find_seller's below, as a function, run right after the lookup resolves and
// before any other await, so parallel calls can't both pass.
function claim(turn: CrmSellerTurn, sellerId: string): boolean {
  if (turn.cardId === null) turn.cardId = sellerId
  return turn.cardId === sellerId
}

export async function runCrmSellerTool(name: string, input: unknown, turn: CrmSellerTurn = newCrmSellerTurn()): Promise<CrmSellerToolRun> {
  if (name === 'find_seller') {
    let output: FindSellerResult & { note?: string } = await findSeller(input as FindSellerInput)
    // Checked and set with no await in between, so parallel calls can't both pass.
    if ('match' in output) {
      if (turn.cardId === null) turn.cardId = output.match.id
      else if (turn.cardId !== output.match.id) {
        const { id, name: sellerName, neighborhood } = output.match
        output = { candidates: [{ kind: 'crm_seller', id, name: sellerName, neighborhood }], note: ONE_SELLER_PER_MESSAGE }
      }
    }
    const card = 'match' in output ? withoutPriceFacts(output.match) : null
    const totalMatched = 'match' in output ? 1 : 'candidates' in output ? output.candidates.length : 0
    return { output, forModel: findSellerForModel(output), card, matchesCard: null, totalMatched }
  }
  if (name === 'count_sellers') {
    const output = await countSellers(input as CountSellersInput)
    return { output, forModel: output, card: null, matchesCard: null, totalMatched: output.count }
  }
  if (name === 'get_seller_matches') {
    // find_seller's own lookup (and its candidates / none), then the one-seller check.
    const found = await findSeller(input as GetSellerMatchesInput)
    let output: GetSellerMatchesResult & { note?: string }
    if (!('match' in found)) output = found
    else if (!claim(turn, found.match.id)) {
      const { id, name: sellerName, neighborhood } = found.match
      output = { candidates: [{ kind: 'crm_seller', id, name: sellerName, neighborhood }], note: ONE_SELLER_PER_MESSAGE }
    } else output = await loadSellerMatches(await getCurrentOrgId(), sellerOf(found.match))
    // A card only when there are buyers to show; "none yet" is Drift's one line.
    const matchesCard: SellerMatchesCard | null = 'seller' in output && output.count > 0
      ? { kind: 'seller_matches', ...output, seller: withoutPriceFacts(output.seller) }
      : null
    const totalMatched = 'seller' in output ? output.count : 'candidates' in output ? output.candidates.length : 0
    return { output, forModel: getSellerMatchesForModel(output), card: null, matchesCard, totalMatched }
  }
  if (name === 'count_matches') {
    const output = await countMatches(input as CountMatchesInput)
    return { output, forModel: output, card: null, matchesCard: null, totalMatched: output.count }
  }
  if (name === 'count_sellers_with_buyers') {
    const output = await countSellersWithBuyers()
    return { output, forModel: output, card: null, matchesCard: null, totalMatched: output.count }
  }
  throw new Error(`Unknown CRM seller tool: ${name}`)
}
