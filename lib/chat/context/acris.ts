import type { ContextFetcher } from './types'
import { findPropertyRecords, formatForChat, SALE_WORDS } from '@/lib/acris'
import { cityRecordsAddress } from './cityRecordsAddress'

const ACRIS_KEYWORDS = [
  'who owns', 'owns', 'ownership', 'acris', 'property record',
  'sold for', 'last sale', 'sale price', 'what did', 'purchase price',
  'deed', 'look up', 'lien', 'mortgage on', 'bought', 'bought for', 'paid for',
]

// Triggered by parsed.isACRIS (from queryParser) OR an explicit keyword, or
// (Brief 43 PR 11, Q25) a sale question: "when did … last sell", "has it sold".
// Requires an address in the user's message; silently skips otherwise.
//
// Brief 43 PR 11 (Q16): the lookup searches that building in that borough
// (cityRecordsAddress), and says so when the borough was assumed. Deed-owner
// names may be shown: D1 [Ryan, 2026-10-17].
export const acrisFetcher: ContextFetcher = async ({ parsed, userMessage }) => {
  const messageLower = userMessage.toLowerCase()
  const trigger = parsed.isACRIS || ACRIS_KEYWORDS.some(k => messageLower.includes(k)) || SALE_WORDS.test(messageLower)
  if (!trigger) return { block: null }

  const place = cityRecordsAddress(userMessage, parsed)
  if (!place) return { block: null }

  try {
    const found = await findPropertyRecords(place.display, { boroughCode: place.boroughCode })
    // A request that failed or ran out of time: say nothing (Brief 43 PR 4's
    // note covers a timeout), rather than "nothing on file".
    if (found.status === 'failed') return { block: null }
    const body = found.status === 'found'
      ? formatForChat(found.result)
      : `ACRIS PROPERTY RECORDS — ${place.display}\nNo deed records on file for this address in ${place.boroughName}.`
    return { block: `\n\n${body}${place.note}` }
  } catch {
    return { block: null }
  }
}
