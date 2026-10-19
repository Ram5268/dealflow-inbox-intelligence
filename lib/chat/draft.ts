// Brief 43 PR 3 (Q3): the shape of a Drift draft, an email or text Ryan asked
// for, to copy and send himself (nothing is sent [Ryan, 2026-09-24]). It comes
// back in drift_response's `draft` field, apart from the reply text, so the page
// can show it as a copyable block and lib/chat/guards/draftPrivacy.ts can check
// it. Kept in its own small file so the page and the stored-reply reader don't
// load the checker. Shape fixed in Brief 43's CONTRACT.md ("PR 3").
export type DraftChannel = 'email' | 'text'
// buyer_side: a buyer or a buyer's agent. homeowner: the owner of the home it's
// about. other: anyone else.
export type DraftAudience = 'buyer_side' | 'homeowner' | 'other'

export interface Draft {
  channel: DraftChannel
  audience: DraftAudience
  subject?: string
  body: string
}

// Review r1: the markup the route strips from the reply (route.ts cleanResponse:
// **bold**, *italic*, stray [DEAL:id] tags) comes out of a draft too, so Ryan
// never copies it. Line breaks are kept.
function stripMarkup(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/[ \t]*\[DEAL:[^\]]+\]/g, '')
}

// The model's (or a stored row's) draft, made safe to use: a non-empty body,
// a known channel and audience (an unknown audience is "other"), and a subject
// only on an email. Anything else is no draft.
export function normalizeDraft(raw: unknown): Draft | null {
  // Review r1: a tool call can carry the object as a JSON string, or just the
  // message as text; either way it's still the draft (and still checked).
  if (typeof raw === 'string') {
    const text = raw
    // Plain text counts only when it reads like a message ("none" or "n/a" is no draft).
    const asBody = text.trim().split(/\s+/).length >= 4 ? { body: text } : null
    try { raw = JSON.parse(text) } catch { raw = asBody }
    if (typeof raw === 'string') raw = asBody
  }
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const body = typeof r.body === 'string' ? stripMarkup(r.body.replace(/\r\n?/g, '\n')).trim() : ''
  if (!body) return null
  const subject = typeof r.subject === 'string' && stripMarkup(r.subject).trim() ? stripMarkup(r.subject).trim() : undefined
  const channel: DraftChannel = r.channel === 'email' || r.channel === 'text' ? r.channel : subject ? 'email' : 'text'
  const audience: DraftAudience = r.audience === 'buyer_side' || r.audience === 'homeowner' ? r.audience : 'other'
  return { channel, audience, ...(channel === 'email' && subject ? { subject } : {}), body }
}
