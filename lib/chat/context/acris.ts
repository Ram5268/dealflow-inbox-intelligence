import type { ContextFetcher } from './types'
import { lookupProperty, formatForChat, extractAddressFromText } from '@/lib/acris'

const ACRIS_KEYWORDS = [
  'who owns', 'owns', 'ownership', 'acris', 'property record',
  'sold for', 'last sale', 'sale price', 'what did', 'purchase price',
  'deed', 'look up', 'lien', 'mortgage on', 'bought', 'bought for', 'paid for',
]

// Triggered by parsed.isACRIS (from queryParser) OR an explicit keyword.
// Requires an address in the user's message; silently skips otherwise.
export const acrisFetcher: ContextFetcher = async ({ parsed, userMessage }) => {
  const messageLower = userMessage.toLowerCase()
  const trigger = parsed.isACRIS || ACRIS_KEYWORDS.some(k => messageLower.includes(k))
  if (!trigger) return { block: null }

  const detectedAddress = extractAddressFromText(userMessage)
  if (!detectedAddress) return { block: null }

  try {
    const data = await lookupProperty(detectedAddress)
    return { block: data ? `\n\n${formatForChat(data)}` : null }
  } catch {
    return { block: null }
  }
}
