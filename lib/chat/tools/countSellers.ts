// Brief 43 PR 5 — count_sellers tool. Counts of Ryan's CRM sellers are fine
// under D11 [Ryan, 2026-10-18] (S-02); the names never are. A database count
// over every seller, so "how many in Bed-Stuy" is the true number, not one
// capped by the old newest-500 window (N2) or the 20-row side block (Q6).
import { z } from 'zod'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { isTestModeOnly } from '@/lib/config/testMode'
import { areaLabel, countCrmSellers } from '@/lib/chat/crmSellers'

export const countSellersInputSchema = z.object({
  neighborhood: z.string().optional(),
})

export type CountSellersInput = z.infer<typeof countSellersInputSchema>

export async function countSellers(rawInput: CountSellersInput): Promise<{ count: number; neighborhood: string | null }> {
  const input = countSellersInputSchema.parse(rawInput ?? {})
  const neighborhood = areaLabel(input.neighborhood)
  // TEST_MODE_ONLY: CRM sellers are real data, so test mode counts none.
  if (isTestModeOnly()) return { count: 0, neighborhood }
  const organizationId = await getCurrentOrgId()
  return { count: await countCrmSellers(organizationId, input.neighborhood), neighborhood }
}
