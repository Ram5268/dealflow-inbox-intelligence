// Brief 43 PR 5: dispatch for the two CRM-seller tools (find_seller,
// count_sellers), kept out of app/api/chat/route.ts so the route only routes.
//   output    the full result, for the guard's grounding and PR 3's draft check
//             (a seller card is any object with kind 'crm_seller')
//   forModel  what Drift reads back (no CRM link, see findSellerForModel)
//   card      the seller card the page shows, when there is exactly one match
import { findSeller, findSellerForModel, type FindSellerInput } from './findSeller'
import { countSellers, type CountSellersInput } from './countSellers'
import type { SellerCard } from '@/lib/chat/sellerCard'

export const CRM_SELLER_TOOL_NAMES = new Set(['find_seller', 'count_sellers'])

export interface CrmSellerToolRun {
  output: unknown
  forModel: unknown
  card: SellerCard | null
  totalMatched: number
}

export async function runCrmSellerTool(name: string, input: unknown): Promise<CrmSellerToolRun> {
  if (name === 'find_seller') {
    const output = await findSeller(input as FindSellerInput)
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
