// Brief 43 PR 3: how Drift's reply is stored in ChatMessage.content. A plain
// reply is its text, as before. A reply with a calendar proposal (stored this way
// since before Brief 41, so the confirm path can read it) or a draft (Brief 43
// PR 3) is JSON in the same column, so a reopened chat shows the draft with no
// migration. readStoredReply gives the page and the History list the reply text
// and the draft back.
// Brief 43 PR 14 (D7, a Brief 42 default): no follow-up suggestions are stored
// any more. Older rows that have them still read the same way (the field is
// ignored).
// Brief 43 PR 8 (Q14): a reply that showed cards, or was about a buyer or a
// report, also carries `shown`, the note of what Ryan saw with it
// (lib/chat/shownFooter.ts); the model's history reads it, the page doesn't.
import { normalizeDraft, type Draft } from './draft'
import { normalizeShown, shownNoteText, type ShownFooter } from './shownFooter'

export function encodeStoredReply(r: {
  response: string
  pendingEvent?: Record<string, string> | null
  draft?: Draft | null
  shown?: ShownFooter | null
}): string {
  if (!r.pendingEvent && !r.draft && !r.shown) return r.response
  return JSON.stringify({
    response: r.response,
    ...(r.pendingEvent ? { pendingEvent: r.pendingEvent } : {}),
    ...(r.draft ? { draft: r.draft } : {}),
    ...(r.shown ? { shown: r.shown } : {}),
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

// Brief 43 PR 8: the stored note, or null (plain text and older JSON rows have none).
export function readStoredShown(content: string): ShownFooter | null {
  if (!content.trimStart().startsWith('{')) return null
  try {
    return normalizeShown((JSON.parse(content) as { shown?: unknown })?.shown)
  } catch { return null }
}

// Brief 43 PR 3 (review r1): the stored reply as the model's history turn: the
// reply text, and the draft after it as "Draft (email, buyer_side): ..." (the way
// the draft rewrite shows it), never the JSON. Brief 43 PR 8: then the Shown note,
// its card list only when withCards (lib/chat/history.ts historyForModel).
export function storedReplyForModel(content: string, opts: { withCards?: boolean } = {}): string {
  const { response, draft } = readStoredReply(content)
  const note = shownNoteText(readStoredShown(content), { withCards: opts.withCards ?? true })
  const text = !draft ? response
    : [response, '', `Draft (${draft.channel}, ${draft.audience}):`, ...(draft.subject ? [`Subject: ${draft.subject}`] : []), draft.body].join('\n').trim()
  return note ? `${text}\n\n${note}` : text
}
