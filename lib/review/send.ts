// Brief 48 (PR 3, item 4.7): the Review Queue page's call to PATCH /api/review,
// and what it makes of the reply. The page used to ignore the reply, so a refused
// or failed save still took the item off the screen. This returns null when the
// save worked, or the message to show under the item when it didn't: the
// server's own message when it sent one, else a calm one of these. It also
// loads the queue: a failed load used to show "Queue is clear." (or "Loading…"
// for good on a network error); now it says the queue didn't load. No server
// imports, because the page ('use client') uses it.
export const SAVE_FAILED = "That didn't save, so the item is still in the queue. Please try again."
export const UNREACHABLE = "DealFlow couldn't be reached, so the item is still in the queue. Check the connection and try again."
export const LOAD_FAILED = "The review queue didn't load. Reload the page in a moment to try again."

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

// The pending items, as the page has always read them, or LOAD_FAILED when the
// reply is an error, isn't JSON, has no item list, or never comes.
export async function loadReviewQueue<T = unknown>(
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<{ ok: true; items: T[] } | { ok: false; message: string }> {
  try {
    const res = await fetchImpl('/api/review?status=pending&limit=50')
    if (!res.ok) return { ok: false, message: LOAD_FAILED }
    const data: unknown = await res.json()
    const items = data && typeof data === 'object' ? (data as { items?: unknown }).items : null
    return Array.isArray(items) ? { ok: true, items: items as T[] } : { ok: false, message: LOAD_FAILED }
  } catch {
    return { ok: false, message: LOAD_FAILED }
  }
}
