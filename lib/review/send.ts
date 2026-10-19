// Brief 48 (PR 3, item 4.7): the Review Queue page's call to PATCH /api/review,
// and what it makes of the reply. The page used to ignore the reply, so a refused
// or failed save still took the item off the screen. This returns null when the
// save worked, or the message to show under the item when it didn't: the
// server's own message when it sent one, else a calm one of these. No server
// imports, because the page ('use client') uses it.
export const SAVE_FAILED = "That didn't save, so the item is still in the queue. Please try again."
export const UNREACHABLE = "DealFlow couldn't be reached, so the item is still in the queue. Check the connection and try again."

export interface ReviewActionRequest {
  id:           string
  action:       string
  corrections?: Record<string, string>
  notes?:       string
}

export async function sendReviewAction(
  request: ReviewActionRequest,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<string | null> {
  let res: Response
  try {
    res = await fetchImpl('/api/review', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(request),
    })
  } catch {
    return UNREACHABLE
  }
  if (res.ok) return null
  const body: unknown = await res.json().catch(() => null)
  const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : null
  return typeof error === 'string' && error.trim() ? error.trim() : SAVE_FAILED
}
