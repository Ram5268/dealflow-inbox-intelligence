// Brief 43 PR 5 — find_seller tool (D11 [Ryan, 2026-10-18]; by address D13
// [Ryan, 2026-10-19]). The one way Drift reaches a CRM seller: ONE seller Ryan
// names, or whose street address he gives, looked up over every seller in the
// database (no 500 cap). One match is that seller's contact card; several give
// up to 3 candidates (name and neighborhood only) to ask which; none is none.
import { z } from 'zod'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { isTestModeOnly } from '@/lib/config/testMode'
import {
  findSellersByAddress, findSellersByName, toSellerCandidate, toSellerCard,
  type CrmSellerRow, type SellerCandidate, type SellerCard,
} from '@/lib/chat/crmSellers'

export const findSellerInputSchema = z.object({
  name: z.string().optional(),
  address: z.string().optional(),
})

export type FindSellerInput = z.infer<typeof findSellerInputSchema>

export type FindSellerResult =
  | { match: SellerCard }
  | { candidates: SellerCandidate[] }
  | { none: true }

const MAX_CANDIDATES = 3

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean)
const hasEveryWord = (fullName: string, name: string) => {
  const have = new Set(words(fullName))
  return words(name).every(w => have.has(w))
}

export async function findSeller(rawInput: FindSellerInput): Promise<FindSellerResult> {
  const input = findSellerInputSchema.parse(rawInput ?? {})
  // TEST_MODE_ONLY: CRM sellers are real data, so test mode never reaches them
  // (as search_parties did before).
  if (isTestModeOnly()) return { none: true }
  const organizationId = await getCurrentOrgId()
  const name = input.name?.trim() ?? ''
  const address = input.address?.trim() ?? ''

  let rows: CrmSellerRow[] = []
  if (address) {
    rows = await findSellersByAddress(address, organizationId)
    // Several sellers at the address and a name too: keep the ones with that name.
    if (rows.length > 1 && name) {
      const named = rows.filter(r => hasEveryWord(r.fullName, name))
      if (named.length > 0) rows = named
    }
  }
  if (rows.length === 0 && name) rows = await findSellersByName(name, organizationId)

  if (rows.length === 1) return { match: toSellerCard(rows[0]) }
  if (rows.length > 1) return { candidates: rows.slice(0, MAX_CANDIDATES).map(toSellerCandidate) }
  return { none: true }
}

// What Drift reads back: the same result without the CRM link (the page shows
// it as the "Open in CRM" button). A URL Drift copied into its text would trip
// the guard's external_url check and end in the stock reply (Q19)
// [engineering precaution].
export function findSellerForModel(result: FindSellerResult): unknown {
  if (!('match' in result)) return result
  const { crmUrl, ...card } = result.match
  return { match: { ...card, openInCrmButton: crmUrl != null }, shownToRyanAs: 'a contact card with an Open in CRM button' }
}
