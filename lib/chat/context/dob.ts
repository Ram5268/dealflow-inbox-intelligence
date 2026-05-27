import type { ContextFetcher } from './types'
import { lookupDOB, formatDobForChat } from '@/lib/dobLookup'
// Address extraction is shared with the ACRIS fetcher — both reuse lib/acris's extractor.
import { extractAddressFromText } from '@/lib/acris'

const DOB_KEYWORDS = [
  'permit', 'violation', 'dob', 'department of buildings', 'air rights',
  'underbuilt', 'renovation permit', 'alteration', 'new building', 'stop work', 'filing',
  'zoning', 'far ', 'floor area ratio', 'landmark', 'lpc', 'historic district',
]

// Triggered by parsed.isDOB (from queryParser) OR an explicit keyword.
// Requires an address in the user's message.
export const dobFetcher: ContextFetcher = async ({ parsed, userMessage }) => {
  const messageLower = userMessage.toLowerCase()
  const trigger = parsed.isDOB || DOB_KEYWORDS.some(k => messageLower.includes(k))
  if (!trigger) return { block: null }

  const detectedAddress = extractAddressFromText(userMessage)
  if (!detectedAddress) return { block: null }

  try {
    const data = await lookupDOB(detectedAddress)
    return { block: data ? formatDobForChat(data) : null }
  } catch {
    return { block: null }
  }
}
