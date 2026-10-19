import type { ContextFetcher } from './types'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { isTestModeOnly } from '@/lib/config/testMode'
import { areaLabel, countCrmSellers } from '@/lib/chat/crmSellers'

// Brief 43 PR 5 (Q6; D11 [Ryan, 2026-10-18]): the CRM-seller side block is
// counts only ("N of your CRM sellers are in Bed-Stuy"). It used to hand Drift
// up to 20 sellers' names, phones, addresses, call results and notes on any
// neighborhood, "my buyer" or email-campaign message. Now it gives no name,
// phone, address or note, counts every seller in the pool (no 20-row window),
// and fires only on a neighborhood or on seller words. One named seller's
// contact comes from find_seller instead.
const MAX_AREAS = 3
const SELLER_WORDS = /\bsellers\b/

export const mojoFetcher: ContextFetcher = async ({ parsed, queryText }) => {
  // Brief 5.0 — CRM data is real data: skip entirely in test mode.
  if (isTestModeOnly()) return { block: null }
  const askedAboutSellers = parsed.isSellerLead || SELLER_WORDS.test(queryText)
  const areas = [...new Set(parsed.neighborhoods.map(n => areaLabel(n)).filter((a): a is string => !!a))].slice(0, MAX_AREAS)
  if (areas.length === 0 && !askedAboutSellers) return { block: null }

  const organizationId = await getCurrentOrgId()
  const lines: string[] = []
  if (areas.length === 0) {
    lines.push(`You have ${await countCrmSellers(organizationId)} sellers in your CRM.`)
  }
  for (const area of areas) {
    const n = await countCrmSellers(organizationId, area)
    // A neighborhood with none is noise unless Ryan asked about his sellers.
    if (n > 0 || askedAboutSellers) lines.push(`${n} of your CRM sellers are in ${area}.`)
  }
  if (lines.length === 0) return { block: null }
  return { block: '\n\nYOUR CRM SELLERS (counts only):\n' + lines.join('\n') }
}
