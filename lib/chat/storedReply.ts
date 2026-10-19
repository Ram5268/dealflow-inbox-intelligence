// Brief 43 PR 3: how Drift's reply is stored in ChatMessage.content. A plain
// reply is its text, as before. A reply with a calendar proposal (stored this way
// since before Brief 41, so the confirm path can read it) or a draft (Brief 43
// PR 3) is JSON in the same column, so a reopened chat shows the draft with no
// migration. readStoredReply gives the page and the History list the reply text
// and the draft back.
import { normalizeDraft, type Draft } from './draft'

export function encodeStoredReply(r: {
  response: string
  suggestions: string[]
  pendingEvent?: Record<string, string> | null
  draft?: Draft | null
}): string {
  if (!r.pendingEvent && !r.draft) return r.response
  return JSON.stringify({
    response: r.response,
    suggestions: r.suggestions,
    ...(r.pendingEvent ? { pendingEvent: r.pendingEvent } : {}),
    ...(r.draft ? { draft: r.draft } : {}),
  })
}

export function readStoredReply(content: string): { response: string; draft: Draft | null } {
  if (content.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(content) as { response?: unknown; draft?: unknown }
      if (typeof parsed?.response === 'string') return { response: parsed.response, draft: normalizeDraft(parsed.draft) }
    } catch { /* plain text that starts with "{" */ }
  }
  return { response: content, draft: null }
}
