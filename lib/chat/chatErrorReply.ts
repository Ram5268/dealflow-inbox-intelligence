// Brief 43 PR 4 (Q4): what the chat page shows when /api/chat doesn't send a
// normal reply. Vercel's own errors come back as an HTML page, not JSON: a 504
// when the function hits its 60-second limit, a 413 when the request (an
// attached file) is too big. The page used to show "Something went wrong" for
// both. Pure, so it's unit-tested without a browser (chatErrorReply.unit.test.ts).
export const TIMEOUT_PAGE_REPLY = 'That took too long, so I stopped. Try a narrower question.'
export const TOO_BIG_PAGE_REPLY = 'That file is too big. Try a smaller one.'
export const GENERIC_PAGE_REPLY = 'Something went wrong. Try again.'

/**
 * The assistant bubble's text for a reply with HTTP `status` that wasn't a
 * normal one; `body` is its parsed JSON, or null when it wasn't JSON.
 */
export function chatErrorReply(status: number, body: unknown): string {
  if (status === 504) return TIMEOUT_PAGE_REPLY
  if (status === 413) return TOO_BIG_PAGE_REPLY
  const b = (body && typeof body === 'object' ? body : {}) as { response?: unknown; message?: unknown }
  // The server's own words: the route's 500 sends `response`, a refusal `message`.
  if (typeof b.response === 'string' && b.response) return b.response
  if (typeof b.message === 'string' && b.message) return b.message
  return GENERIC_PAGE_REPLY
}
