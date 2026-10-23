// Brief 43 PR 13 (Q22): Drift's side lookups (the parser, the CRM-seller count,
// ACRIS, DOB, matches, calendar and the paid live StreetEasy search) run on
// Ryan's own question, not on text he pastes in. A pasted broker email used to
// be parsed as his question: its "coming soon", its addresses and words like
// "rules" set off a live StreetEasy search, the seller block and lookups for
// the wrong area [engineering precaution]. Drift itself still reads all of it.
//
// A message longer than LONG_PASTE_CHARS counts as a paste. Its first
// paragraph is Ryan's lead-in ("who owns this one?") when it is short and
// doesn't look like an email (From:, Subject:, a forwarded or quoted line);
// otherwise the lookups get nothing. The StreetEasy search never runs on a
// paste turn (liveStreetEasy.ts). Attached files never reach the lookups: not
// their text, and not their names either.
export const LONG_PASTE_CHARS = 400
export const LEAD_IN_MAX_CHARS = 200
const EMAIL_LINE = /^[ \t]*(?:(?:from|to|cc|bcc|subject|sent|date|fwd?|re):|-{2,}|>)/im

// Reviewer patch (PR 13 r1): the chat box sends on Enter and a spoken (voice
// mode) message has no line breaks, so a long message on one line with no
// email line is Ryan's own question; a paste keeps its line breaks
// [engineering precaution].
export const OWN_LINE_MAX_CHARS = 1500

export function lookupQuestion(message: string): { text: string; pasted: boolean } {
  const text = message.replace(/\r\n?/g, '\n').trim()
  if (text.length <= LONG_PASTE_CHARS) return { text, pasted: false }
  if (text.length <= OWN_LINE_MAX_CHARS && !text.includes('\n') && !EMAIL_LINE.test(text)) return { text, pasted: false }
  const leadIn = text.split(/\n[ \t]*\n/, 1)[0].trim()
  const ownWords = leadIn.length <= LEAD_IN_MAX_CHARS && !EMAIL_LINE.test(leadIn)
  return { text: ownWords ? leadIn : '', pasted: true }
}
