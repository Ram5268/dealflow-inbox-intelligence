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

// The model's (or a stored row's) draft, made safe to use: a non-empty body,
// a known channel and audience (an unknown audience is "other"), and a subject
// only on an email. Anything else is no draft.
export function normalizeDraft(raw: unknown): Draft | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const body = typeof r.body === 'string' ? r.body.replace(/\r\n?/g, '\n').trim() : ''
  if (!body) return null
  const subject = typeof r.subject === 'string' && r.subject.trim() ? r.subject.trim() : undefined
  const channel: DraftChannel = r.channel === 'email' || r.channel === 'text' ? r.channel : subject ? 'email' : 'text'
  const audience: DraftAudience = r.audience === 'buyer_side' || r.audience === 'homeowner' ? r.audience : 'other'
  return { channel, audience, ...(channel === 'email' && subject ? { subject } : {}), body }
}
