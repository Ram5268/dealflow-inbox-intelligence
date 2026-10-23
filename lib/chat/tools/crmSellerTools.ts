// Brief 43 PR 5: dispatch for the two CRM-seller tools (find_seller,
// count_sellers), kept out of app/api/chat/route.ts so the route only routes.
//   output    the full result, for the guard's grounding and PR 3's draft check
//             (a seller card is any object with kind 'crm_seller')
//   forModel  what Drift reads back (no CRM link, see findSellerForModel)
//   card      the seller card the page shows, when there is exactly one match
import { findSeller, findSellerForModel, type FindSellerInput, type FindSellerResult } from './findSeller'
import { countSellers, type CountSellersInput } from './countSellers'
import type { SellerCard } from '@/lib/chat/sellerCard'

export const CRM_SELLER_TOOL_NAMES = new Set(['find_seller', 'count_sellers'])

export interface CrmSellerToolRun {
  output: unknown
  forModel: unknown
  card: SellerCard | null
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
    const card = 'match' in output ? output.match : null
    const totalMatched = 'match' in output ? 1 : 'candidates' in output ? output.candidates.length : 0
    return { output, forModel: findSellerForModel(output), card, totalMatched }
  }
  if (name === 'count_sellers') {
    const output = await countSellers(input as CountSellersInput)
    return { output, forModel: output, card: null, totalMatched: output.count }
  }
  throw new Error(`Unknown CRM seller tool: ${name}`)
}
