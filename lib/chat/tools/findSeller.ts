// Brief 43 PR 5 — find_seller tool (D11 [Ryan, 2026-10-18]; by address D13
// [Ryan, 2026-10-19]). The one way Drift reaches a CRM seller: ONE seller Ryan
// names, or whose street address he gives, looked up over every seller in the
// database (no 500 cap). One match is that seller's contact card; several give
// up to 3 candidates (name and neighborhood only) to ask which; none is none.
import { z } from 'zod'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { isTestModeOnly } from '@/lib/config/testMode'
import {
  findSellersByAddress, findSellersByName, sameNeighborhood, toSellerCandidate, toSellerCard,
  type CrmSellerRow, type SellerCandidate, type SellerCard,
} from '@/lib/chat/crmSellers'

export const findSellerInputSchema = z.object({
  name: z.string().optional(),
  address: z.string().optional(),
  // Only to pick one of several same-name candidates: the neighborhood Ryan chose.
  neighborhood: z.string().optional(),
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
    // A name too: keep the sellers at the address with that name. If nobody
    // there has it, whoever is at the address isn't shown as the person Ryan
    // named (a wrong-person contact, #10b): they come back as candidates, so
    // Drift asks [engineering precaution].
    if (rows.length > 0 && name) {
      const named = rows.filter(r => hasEveryWord(r.fullName, name))
      if (named.length === 0) return { candidates: rows.slice(0, MAX_CANDIDATES).map(toSellerCandidate) }
      rows = named
    }
  }
  if (rows.length === 0 && name) rows = await findSellersByName(name, organizationId)
  // Several with that name and Ryan picked one by its neighborhood (the "which
  // one?" question): keep that one. A neighborhood alone looks up nobody.
  const neighborhood = input.neighborhood?.trim() ?? ''
  if (rows.length > 1 && neighborhood) {
    const picked = rows.filter(r => sameNeighborhood(r.neighborhood, neighborhood))
    if (picked.length > 0) rows = picked
  }

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
