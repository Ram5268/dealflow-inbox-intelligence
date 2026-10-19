import type { ContextFetcher } from './types'
import { findDobRecords, formatDobForChat } from '@/lib/dobLookup'
// Address extraction is shared with the ACRIS fetcher — both read the address
// and its borough the same way (Brief 43 PR 11).
import { cityRecordsAddress } from './cityRecordsAddress'

const DOB_KEYWORDS = [
  'permit', 'violation', 'dob', 'department of buildings', 'air rights',
  'underbuilt', 'renovation permit', 'alteration', 'new building', 'stop work', 'filing',
  'zoning', 'far ', 'floor area ratio', 'landmark', 'lpc', 'historic district',
]

// Triggered by parsed.isDOB (from queryParser) OR an explicit keyword.
// Requires an address in the user's message.
//
// Brief 43 PR 11 (M30, Q16): permits and violations for that building in that
// borough, or "none on file" (DRIFT_SCRIPT #22), and a note when the borough
// was assumed [engineering precaution].
export const dobFetcher: ContextFetcher = async ({ parsed, userMessage, previousUserMessage }) => {
  const messageLower = userMessage.toLowerCase()
  const trigger = parsed.isDOB || DOB_KEYWORDS.some(k => messageLower.includes(k))
  if (!trigger) return { block: null }

  const place = cityRecordsAddress(userMessage, parsed, previousUserMessage)
  if (!place) return { block: null }

  try {
    const found = await findDobRecords(place.display, { boroughCode: place.boroughCode })
    if (found.status === 'failed') return { block: null }
    const body = found.status === 'found'
      ? formatDobForChat(found.result)
      // Brief 43 PR 11 review: only the older DOB permit records and DOB
      // violations are searched, by this spelling of the address. Most permits
      // since about 2021 are filed in the city's newer system (DOB NOW), and
      // HPD and ECB violations are kept apart, so Drift says what was checked
      // [engineering precaution].
      : `\n\nDOB RECORDS — ${found.label}\nNo permits or violations found for this address as written, in the older DOB permit records and DOB violations. Permits filed in the city's newer system (DOB NOW, most permits since about 2021) and HPD or ECB violations are not checked here, so say none were found in the records checked, not that there are none.`
    return { block: `${body}${place.note}` }
  } catch {
    return { block: null }
  }
}
