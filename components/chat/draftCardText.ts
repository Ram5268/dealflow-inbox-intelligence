// Brief 43 PR 3: the words on the copyable draft block in chat (DraftCard.tsx),
// kept here so they can be tested without a browser. Feel standard: calm, no
// exclamation marks, no em-dashes.
import type { Draft } from '@/lib/chat/draft'

export const DRAFT_NOTE = 'Nothing is sent. Copy it and send it yourself.'
export const COPY_FAILED = "Copy didn't work. Press and hold the text to select it."

export function draftHeading(d: Draft): string {
  const kind = d.channel === 'email' ? 'Email draft' : 'Text draft'
  if (d.audience === 'buyer_side') return `${kind} for the buyer or their agent`
  if (d.audience === 'homeowner') return `${kind} for the homeowner`
  return kind
}

export function draftCopyText(d: Draft, part: 'body' | 'subject'): string {
  return part === 'subject' ? d.subject ?? '' : d.body
}
