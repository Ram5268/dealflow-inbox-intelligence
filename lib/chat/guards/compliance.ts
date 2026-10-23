// Brief 43 PR 2 (Q2) — a code-level "never sent" check for the guard.
//
// Nothing contacts anyone [Ryan, 2026-09-24]: Drift can't send, text, email,
// call, invite, book or add to the calendar, and must never say it did. The
// prompt already says so (RYAN_MD's hard rules; Brief 43 PR 1), but nothing in
// code caught a reply that claimed otherwise: Brief 46's probes (drift-1 p7,
// drift-2 p3) showed "Sent. The text is on its way" passing with no flag. This
// scan flags those claims as `action_claim`, which the guard loop in
// app/api/chat/route.ts treats like any other structural flag: one rewrite with
// feedback, then the fixed NEVER_SENT_REPLY (retry.ts) on a second failure.
// The flag is never tool-bindable (toolBinding.ts).
//
// A false alarm costs about 2 extra Sonnet calls and can replace a good reply,
// so the scan is deliberately narrow [engineering precaution]:
// - It reads clause by clause. A negation earlier in the clause ("can't",
//   "won't", "didn't", "not", "never", "unable", "nothing", ...) passes, so
//   Drift's own declines pass ("I can't send texts; the draft is ready to copy").
// - Hypotheticals pass ("once it's sent", "if you send it"), and so do
//   questions ("Want me to draft a text you can send?").
// - Inbox talk passes. Agents send Ryan listings, so a third-person sender ("the
//   agent emailed you"), "sent by", "was sent on Oct 3" and "scheduled for
//   completion" are not claims. Only Drift's own first person ("I've sent"),
//   bare past-tense lines ("Sent." "Booked for Thursday at 3") and a short list
//   of state phrases ("it's on its way", "added to your calendar") count.
// - Draft text passes: anything in quotes, CRM notes relayed as written, and
//   an inline draft from its greeting, "Here's the draft:" lead-in, or (when
//   signed) a name line or colon line, to its "Ryan Martin" sign-off. A follow-up
//   in Ryan's voice may say "I sent you the floor plans"; those are his words
//   to copy, not Drift's claim. Brief 43 PR 3 moves drafts into their own
//   `draft` field, after which the guard scans only Drift's own text.
// - "Done" (and "Scheduled for Friday") counts only right after a send
//   request ("send it", "text the owner", "book a showing"), so "Done. Here's
//   the Buyer Match report" still passes.
// - First person means "I". "We have scheduled an open house" is how an
//   agent's email reads, and Ryan's drafts say "we"; those are left to the
//   fact-check.
import type { RegexFlag } from './regexGuard'

export const ACTION_CLAIM = 'action_claim'

export interface ActionClaimOptions {
  // This turn's user message. Only used to read a bare "Done" after a send
  // request as a claim.
  userMessage?: string | null
}

// Curly apostrophes and quotes to straight ones, and runs of spaces/tabs to one
// space, so every pattern below can use a single literal space (no unbounded
// quantifiers, and none inside a lookaround).
function normalize(s: string): string {
  return s
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    // An emoji or check mark that ends a line or sentence ends a claim like a
    // period ("Sent ✅", "Scheduled 👍"); one mid-sentence is dropped.
    .replace(/ ?[\p{Extended_Pictographic}\u2713\u2714\uFE0F]+(?= ?(?:$|\n|[A-Z]))/gu, '.')
    .replace(/[\p{Extended_Pictographic}\u2713\u2714\uFE0F]+/gu, ' ')
    .replace(/[ \t\u00A0]+/g, ' ')
}

// ── Draft text (Ryan's words to copy, not Drift's claims) ────────────────────
const CODE_FENCE = /```[\s\S]*?```/g
const BLOCKQUOTE = /^ ?>.*$/gm
const QUOTED = /"[^"]{1,4000}"/g
// CRM notes relayed as written ("Your notes say: Called, left VM."): Ryan's
// shorthand, not Drift's claim. Blanked to the end of the line.
const RELAYED_NOTES = /\b(?:notes|(?:the|your|crm|call|last) notes?|the note|last call(?: result)?|call result|call history|call log|last contact(?:ed)?|last activity|last touch|disposition|outcome|status|(?:your )?crm (?:says|shows))(?: (?:say|says|read|reads|show|shows))?: [^\n]*/gi
// "Here's the draft:" / "Here is a text you can send Pat:" — the draft starts
// after the colon. Not "Here's the short version:", a voice-mode summary.
const DRAFT_LEAD_IN = /\b(?:here's|here is|here are|below is|below are)\b[^:\n]{0,60}?\b(?:drafts?|texts?|emails?|e-mails?|notes?|messages?|repl(?:y|ies)|wording|script|sms|follow-?ups?|(?<!\bshort |\bquick |\blong )versions?|responses?|intros?)\b[^:\n]{0,40}:/gi
// A "Subject:" or "Draft:" label at the start of a line.
const DRAFT_LABEL = /(?:^|\n) ?(?:subject|draft)(?: \d)?:/gi
// A greeting to someone other than Ryan ("Hi Pat,", "Hello there"), at the start
// of a line or sentence. Not "Hey, sent it".
const DRAFT_GREETING = /(?:^|\n|[.!?:] )(?:[Hh]i|[Hh]ello|[Hh]ey|[Dd]ear|[Gg]ood (?:morning|afternoon|evening))(?=[ ,\n])(?!,? Ryan\b)(?!,? (?:sent|texted|emailed|messaged|forwarded|called|booked|scheduled|done|all set|on it|will do)\b)/g
// A salutation line that is only a name ("Jordan," / "Jordan -").
const NAME_SALUTATION = /(?:^|\n)(?!Ryan\b|Best\b|Thanks\b|Cheers\b|Regards\b|Sincerely\b|Warmly\b)[A-Z][a-z]{1,20}(?: [A-Z][a-z]{1,20})?(?:,| -| \u2014) ?(?=\n)/g
// A lead-in line ending in a colon ("Try this:" / "Revised:") starts a draft
// only when a "Ryan" sign-off follows it.
const COLON_LINE = /:[ ]?\n/g
// The "Ryan Martin" (or "Ryan") sign-off that ends a draft: on its own line, or
// after a sentence end or a dash, optionally after "Best," / "Thanks," etc.
// "this is Ryan Martin." inside the body is not a sign-off.
const SIGN_OFF = /(?:^|\n|[.!?] |[-–—] ?)(?:(?:best regards|best|many thanks|thanks|thank you|warm regards|kind regards|regards|warmly|cheers|sincerely|all the best|talk soon),?(?: ?\n ?| ))?ryan(?: martin)?(?: ?\.)?(?= ?(?:\n|$))/gi

/**
 * Blank out quoted text and inline drafts so only Drift's own words are scanned.
 * `draftAsked`: Ryan asked for a draft or an edit, so a signed body with no
 * greeting or lead-in (it starts at the top of the reply) is a draft too.
 */
export function stripDraftText(text: string, opts: { draftAsked?: boolean } = {}): string {
  const s = text.replace(CODE_FENCE, '\n').replace(BLOCKQUOTE, '').replace(QUOTED, '""').replace(RELAYED_NOTES, '\n')
  const starts: number[] = []
  for (const m of s.matchAll(DRAFT_LEAD_IN)) starts.push(m.index + m[0].length)
  for (const m of s.matchAll(DRAFT_LABEL)) starts.push(m.index + (m[0].startsWith('\n') ? 1 : 0))
  for (const m of s.matchAll(DRAFT_GREETING)) starts.push(m.index + m[0].search(/[a-z]/i))
  // These two shapes start a draft only when a sign-off follows.
  let lastSignOff = -1
  SIGN_OFF.lastIndex = 0 // matchAll copies lastIndex; the loop below moves it
  for (const m of s.matchAll(SIGN_OFF)) lastSignOff = m.index
  const signedAfter = (i: number) => i <= lastSignOff
  for (const m of s.matchAll(NAME_SALUTATION)) if (signedAfter(m.index)) starts.push(m.index + (m[0].startsWith('\n') ? 1 : 0))
  for (const m of s.matchAll(COLON_LINE)) if (signedAfter(m.index)) starts.push(m.index + m[0].length)
  if (opts.draftAsked && lastSignOff >= 0) {
    SIGN_OFF.lastIndex = 0
    const first = SIGN_OFF.exec(s)
    if (first && !starts.some(i => i < first.index)) starts.push(0)
  }
  if (starts.length === 0) return s
  starts.sort((a, b) => a - b)
  let out = ''
  let pos = 0
  for (const start of starts) {
    if (start < pos) continue // inside a draft already blanked
    out += s.slice(pos, start) + '\n'
    SIGN_OFF.lastIndex = start
    const end = SIGN_OFF.exec(s)
    // No sign-off: treat the rest as draft (an unsigned draft breaks D2 anyway).
    pos = end ? end.index + end[0].length : s.length
  }
  return out + s.slice(pos)
}

// ── Clauses ──────────────────────────────────────────────────────────────────
// Sentence ends, semicolons, new lines, dashes, colons and ", but" start a new
// clause, so a "can't" in one clause never excuses a claim in the next.
// ", want me to ...?" also starts a clause, so a claim before a trailing
// question ("I've sent it, want a follow-up?") is still read.
const CLAUSE_BREAK = /(?<=[.!?])\s+|[;\n]+|\s[-–—]\s|[–—]|:\s|,\s(?:but|though|although|however|while|whereas)\s|,\s(?=(?:want|should|shall|would|could|can|do|does|did|anything|need|is|are|ok|okay|sound|how|what|which|who|when|where)\b)/gi

const NEGATION = /\b(?:not|never|no|nothing|nobody|none|neither|nor|cannot|unable|without)\b|n't\b|\b(?:cant|wont|dont|didnt|doesnt|havent|hasnt|isnt|wasnt|arent|werent|couldnt|wouldnt)\b/i
// Set phrases with "no" that don't negate the claim after them.
const NOT_A_NEGATION = /\bno (?:problem|worries|rush|doubt|pressure|question|trouble|need to wait)\b|\bnot a problem\b|\bdon't worry\b|\bnever mind\b/gi
// "Once it's sent", "if you send it", "when it's booked": not a claim it happened.
const CONDITIONAL = /\b(?:if|once|when|whenever|after|before|until|unless|whether|as soon as)\b/i
const NEGATED_AFTER = /\b(?:nothing|no one|nobody|no-one)\b/i
// Negation scope: the same clause, at most this far back.
const PREFIX_WINDOW = 160

// Optional lead word before a bare claim: "Certainly, sent." "Okay, done."
const LEAD = String.raw`(?:(?:ok|okay|sure|certainly|right|great|perfect|alright|all right|yes|yep|got it|very good|of course|done|hey)[,!.]? )?`
const DAY = String.raw`(?:today|tonight|tomorrow|this|next|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun|noon)`
const PERSON = String.raw`(?:them|him|her|the (?:seller|owner|homeowner|agent|buyer|broker|landlord|tenant|listing|buyer's|office|number))`
const MESSAGE = String.raw`(?:texts?|emails?|e-mails?|messages?|notes?|drafts?|repl(?:y|ies)|invites?|invitations?|sms)`

// A reply that names a sender ("... by Compass", "... by the agent") or cites
// a source ("per the email", "according to the CRM") is reporting the inbox,
// not claiming Drift did it. Used for every shape except Drift's own "I".
// "per month" / "per square foot" (prices) and "by Monday" (a time) don't count.
const INBOX_SOURCE = /\b(?:[Pp]er|[Aa]ccording to) (?:(?:the|their|his|her) [A-Za-z]|your (?:notes?|crm|call (?:log|history|notes)|inbox|emails?|records?|calendar)\b|[A-Z])|\bby (?:the |a |an |their |his |her )?(?:agents?|listing agent|brokers?|brokerage|owner|seller|landlord|developer|sponsor|team|(?!(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tues|Tue|Wed|Thurs|Thur|Thu|Fri|Sat|Sun|January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec|EOD|COB)\b)[A-Z])/

interface ClaimPattern {
  regex: RegExp
  // Drift's own "I ..." claims: a cited source doesn't excuse those.
  firstPerson?: boolean
  // Only read right after a send request.
  sendRequestOnly?: boolean
  // Bare clause-initial shapes carry their own lead and skip the prefix checks.
  anchored?: boolean
  // Past or state claims pass under "if/once/when"; promises ("I'll send it
  // once you approve") don't.
  conditionalPasses?: boolean
  // "the listings I sent you earlier" / "I sent you three listings" means
  // shown in chat, not sent to anyone.
  chatDisplayPasses?: boolean
}

const CLAIM_PATTERNS: ClaimPattern[] = [
  {
    // "Sent." "Sent it to Pat." "Texted the seller." Not "Sent by Compass" /
    // "Sent to you by ..." (inbox talk).
    regex: new RegExp(String.raw`^${LEAD}(?:sent|texted|emailed|e-mailed|messaged|forwarded)(?! by\b| from\b| to you\b| to your inbox\b| over by\b)(?=[.!,]|$| (?:it|that|this|them|him|her|the|to|over|off|out|along|and|a|an|your|both|each|everyone|via|back|now|just|already)\b)`, 'i'),
    anchored: true,
  },
  {
    // "Sending it over now." "Calling them now." Not a gerund subject:
    // "Calling the seller is your call", "Sending a text to ... isn't allowed".
    regex: new RegExp(String.raw`^${LEAD}(?:sending|texting|emailing|forwarding|calling|phoning)(?=[.!,]|$| (?:it|that|this|them|him|her|now|over|off|out|along|back)\b)`, 'i'),
    anchored: true,
  },
  {
    // "Called." "Called the seller." "Called, no answer." Not "Called it" (an
    // idiom) or "Called a 3-family by the agent" (described as).
    regex: new RegExp(String.raw`^${LEAD}(?:called|phoned|rang|dialed|dialled)(?=[.!,]|$| (?:them|him|her|the|and|back|again|your|both|each|everyone|ahead)\b)`, 'i'),
    anchored: true,
  },
  {
    // "Booked." "Booked for Thursday at 3." "Scheduled it." Not "Scheduled for
    // completion in 2027" or "Scheduled showings only" (listing talk).
    regex: new RegExp(String.raw`^${LEAD}(?:booked|scheduled)(?=[.!,]|$| (?:it|that|this|them|him|her|you)\b| (?:the|a) (?:showing|call|meeting|appointment|viewing|tour)\b)|^${LEAD}booked(?= (?:for|on) (?:${DAY}\b|\d)| at \d)`, 'i'),
    anchored: true,
  },
  {
    // "Email sent." "Invite sent to the buyer's agent." "On its way."
    regex: new RegExp(String.raw`^${LEAD}(?:the |your )?(?:calendar )?${MESSAGE} (?:sent|forwarded|delivered)(?! by\b| from\b| to you\b| to your inbox\b)(?=[.!,]|$| (?:to|over|off|out|just|now|already|and)\b)|^${LEAD}on (?:its|their) way\b(?! to (?:the )?(?:market|closing|contract|auction|foreclosure|sale)\b| back\b| out\b)`, 'i'),
    anchored: true,
  },
  {
    // Drift's own first person, past: "I've sent", "I just emailed", "I called
    // the seller", "I've added it to your calendar". Case-sensitive except
    // the pronoun ("i've sent it").
    regex: new RegExp(String.raw`\b[Ii](?:'ve| have)?(?: (?:just|already|also|now|since|successfully|gone ahead and|went ahead and)){0,2} (?:sent|texted|emailed|e-mailed|messaged|forwarded|booked|scheduled|invited|phoned|rang|dialed|dialled|contacted|notified|reached out to|left (?:a|an|them a|him a|her a|[A-Z][a-z]{1,20} a) (?:voicemail|message)|called(?= (?:${PERSON}|you|back|and|again|earlier)\b| [A-Z])|added (?:(?:it|this|that|the [a-z]{1,20}) )?(?:to|on|in) your (?:calendar|[Oo]utlook)|put (?:it|this|that|the [a-z]{1,20}) (?:on|in) your (?:calendar|[Oo]utlook)|set up (?:a|the) (?:showing|call|meeting|appointment|viewing|tour)|(?:pinged|followed up with) (?:${PERSON}\b|[A-Z][a-z]{1,20}\b)|let (?:them|him|her|the [a-z]{1,20}|[A-Z][a-z]{1,20}) know|gave (?:them|him|her|the [a-z]{1,20}|[A-Z][a-z]{1,20}) a (?:call|ring)|shot (?:them|him|her|the [a-z]{1,20}|[A-Z][a-z]{1,20}) (?:a|an) (?:note|text|email|message|line))\b`, 'g'),
    // No conditional pass: "After you asked, I sent it" / "When I texted the
    // seller" are past claims, not hypotheticals.
    chatDisplayPasses: true,
    firstPerson: true,
  },
  {
    // Drift's own first person, promising: "I'll send it now", "I'm calling the
    // seller", "Let me book that". A promise to send is a claim it can.
    regex: new RegExp(String.raw`\b(?:I(?:'ll| will|'m going to| am going to|'m| am)|[Ll]et me)(?: (?:just|now|also|go ahead and|quickly|right away)){0,2} (?:send|sending|text|texting|email|emailing|e-mail|forward|forwarding|book|booking|schedule|scheduling|invite|inviting|message|messaging|reach out to|reaching out to|(?:call|calling|phone|phoning|ring|ringing)(?= ${PERSON}\b| [A-Z])|add (?:it|this|that|the [a-z]{1,20}) to your (?:calendar|[Oo]utlook))\b`, 'g'),
    firstPerson: true,
  },
  {
    // State: "It's sent." "The text has been sent to the seller." "It's been
    // sent to Pat." Passive only, ending the clause or naming who it went to:
    // "agents that have emailed you", "They've sent you three listings", "was
    // sent", "sent by the agent", "sent to you" and "sent around to every
    // buyer's agent" are inbox talk. Case-sensitive so "to Pat" reads as a name.
    regex: new RegExp(String.raw`\b(?:[Ii]t|[Tt]hat|[Tt]his|[Tt]hey|[Bb]oth|(?:[Tt]he|[Yy]our) ${MESSAGE}(?: to [^.!?;:\n]{1,40}?)?)(?:(?:'s|'re| is| are)(?: (?:now|already|just|all))?(?: been)?|(?:'s|'ve| has| have)(?: (?:now|already|just|all))? been) (?:sent|texted|emailed|forwarded)(?=[.!,]|$| to (?:the |your |their )?(?:seller|owner|homeowner|agent|buyer|broker|landlord|tenant|listing agent|buyer's agent|client)s?\b| to [A-Z]| (?:just now|now|already|over|off)\b)`, 'g'),
    conditionalPasses: true,
  },
  {
    // "The text went out." "Your email to the seller is out." One person, not
    // a blast: "The email went out to buyers Tuesday" is an agent's email.
    regex: new RegExp(String.raw`\b(?:[Tt]he|[Yy]our) ${MESSAGE}(?: to [^.!?;:\n]{1,40}?)? (?:went|has gone|is) out(?=[.!,]|$| to (?:the |your |their )?(?:seller|owner|homeowner|agent|buyer|broker|landlord|tenant|listing agent|buyer's agent|client)\b(?!s)| to [A-Z]| (?:a minute ago|just now|now)\b)`, 'g'),
    conditionalPasses: true,
  },
  {
    // "It went out to the owner." only right after a send request;
    // otherwise "It went out to brokers Tuesday" / "It is out now, asking ..."
    // is a listing.
    regex: new RegExp(String.raw`\b(?:[Ii]t|[Tt]hat) (?:went|has gone|is) out(?=[.!,]|$| to (?:the |your |their )?(?:seller|owner|homeowner|agent|buyer|broker|landlord|tenant|listing agent|buyer's agent|client)\b(?!s)| to [A-Z]| (?:a minute ago|just now)\b)`, 'g'),
    conditionalPasses: true,
    sendRequestOnly: true,
  },
  {
    // "The text is on its way." "It's on its way to Pat." Not "on its way to
    // market" (a coming-soon listing), and not people ("They're on their way").
    regex: new RegExp(String.raw`\b(?:it|that|this|(?:the|your) ${MESSAGE})(?:'s|'re| is| are)(?: (?:now|already|all))? on (?:(?:its|their) way\b(?! to (?:the )?(?:market|closing|contract|auction|foreclosure|sale)\b| back\b| out\b)|the way(?=[.!,]|$| (?:now|over)\b| to (?:the |your )?(?:seller|owner|homeowner|agent|buyer|broker|landlord|tenant|client)s?\b))`, 'gi'),
    conditionalPasses: true,
  },
  {
    // Calendar: "Added to your calendar." "Added to your Outlook." "It's on
    // your calendar." Outlook is paused, so Drift can't add anything. ("Put it
    // on your calendar" is advice to Ryan; "I put it ..." is the first-person
    // pattern above.)
    regex: new RegExp(String.raw`\b(?:added|placed|saved)(?: (?:it|this|that|them|the [a-z]{1,20}))? (?:to|on|in|into) your (?:calendar|outlook)\b|\b(?:it|that|this|the (?:showing|appointment|meeting|call|event|viewing|tour))(?:'s| is)(?: (?:now|already|all))? (?:on|in) your (?:calendar|outlook)\b`, 'gi'),
    conditionalPasses: true,
  },
  {
    // Booking state: "The showing is booked." "You're booked for Thursday."
    // ("scheduled" / "confirmed" are left out here: a showing-confirmation
    // email in the inbox is described that way.)
    // Not "It's booked through the agent's showing service" (inbox talk).
    regex: new RegExp(String.raw`\b(?:it|that|this|(?:the|your) (?:showing|appointment|meeting|call|viewing|tour))(?:'s| is| has been|'s been)(?: (?:now|already|all))? booked(?=[.!,]|$| (?:for|at|on|in|now)\b)|\byou(?:'re| are)(?: all)? booked (?:for|in|at)\b`, 'gi'),
    conditionalPasses: true,
  },
]

// Only right after a send request: "Done." "Okay, done." "All set." "Will do."
// ("Certainly." / "Right away." are left out: the prompt has Drift open with them.)
// "Scheduled for Friday at noon." (Without a request, "scheduled for Friday" is
// how Drift describes a showing-confirmation email in the inbox.)
// "Will do" / "On it" / "Handled" count only when the reply has
// no draft; "On it. Here's a short text you can copy: ..." is the draft offer.
const ACK_ONLY = new RegExp(String.raw`^${LEAD}(?:handled|will do|on it)(?=[.!,]|$| (?:and|it|that)\b)`, 'i')
const AFTER_SEND_REQUEST: RegExp[] = [
  new RegExp(String.raw`^${LEAD}(?:done|all done|all set|you're all set|it's done|that's done|consider it (?:done|sent)|(?:that's |it's )?(?:been )?taken care of)(?=[.!,]|$| (?:and|it|that)\b)`, 'i'),
  new RegExp(String.raw`^${LEAD}(?:scheduled|confirmed|set) for (?:${DAY}\b|\d)`, 'i'),
  // Booking confirmations: "You're all set for Thursday at 3pm."
  new RegExp(String.raw`^${LEAD}(?:you're|you are) (?:all )?(?:set|confirmed|booked) for (?:${DAY}\b|\d)|^${LEAD}(?:the |your )?(?:showing|appointment|meeting|call|viewing|tour)(?: is| has been|'s)? (?:confirmed|set|scheduled)(?=[.!,]|$| for (?:${DAY}\b|\d))`, 'i'),
]

// Nouns for what Drift shows in chat: "the listings I sent you earlier".
const CHAT_DISPLAY_BEFORE = /\b(?:listings?|ones?|options?|results?|matches|match|lists?|buyers?|sellers?|properties|homes?|units?|cards?|links?|reports?|sections?|details|numbers?|names?|addresses|figures?|comps?|picks?)(?: (?:that|which))? $/i

// ── Send requests ────────────────────────────────────────────────────────────
const SEND_FILLERS = /^(?:(?:ok|okay|yes|yeah|yep|sure|great|perfect|cool|thanks|thank you|alright|all right|and|then|now|just|please|pls|go ahead and|go ahead|can you|could you|would you|will you|you can|looks good|sounds good|that works|good)[\s,.!]+){0,6}/
const SEND_START = /^(?:send(?! me\b)|resend|re-send|text|email|e-mail|forward|call|phone|ring|dial|book|schedule|invite|message|ping|contact|reach out|mail|fire (?:it|that|this) off|shoot (?:it|that|this|them|him|her) (?:over|off|out))\b(?!-| (?:from|list|lists|notes?|log|logs|history|results?|queue|info|details|thread|value|is|was|says|said)\b)/
const SEND_ANYWHERE = /\b(?:send|resend|forward) (?:it|that|this|them|both|those|these|the (?:text|email|e-mail|note|message|draft|reply|invite))\b|\b(?:add|put) (?:it|this|that|the [a-z]{1,20}) (?:to|on|in) (?:my|the) (?:calendar|outlook)\b/
// Asking for a draft or an edit is not a send request ("Done. Here's the draft").
const DRAFT_ASK = /\b(?:draft|drafts|drafting|write|compose|prepare|wording|template|rewrite|reword|redo|edit|revise|tweak|polish|shorter|longer|softer|version)\b/

/** True when Ryan's message asks Drift to send, text, email, call, book or invite. */
export function isSendRequest(userMessage: string | null | undefined): boolean {
  if (!userMessage) return false
  const m = normalize(userMessage).toLowerCase().trim()
  if (!m) return false
  // The first line only: a pasted email's own words ("Please forward this to
  // your buyers") are not Ryan's request.
  const head = m.split('\n')[0].slice(0, 200)
  // An explicit "send it" counts even with an edit ("make it shorter and send it").
  if (SEND_ANYWHERE.test(head)) return true
  if (DRAFT_ASK.test(m)) return false
  return SEND_START.test(head.replace(SEND_FILLERS, ''))
}

/**
 * Flag replies that say or promise that something was sent, texted, emailed,
 * called, booked or added to the calendar. Returns one `action_claim` flag per
 * claim; empty means no claim found.
 */
export function scanActionClaims(text: string, opts: ActionClaimOptions = {}): RegexFlag[] {
  if (!text) return []
  const draftAsked = !!opts.userMessage && DRAFT_ASK.test(normalize(opts.userMessage).toLowerCase())
  const sendRequest = isSendRequest(opts.userMessage)
  const normalized = normalize(text)
  const scanned = stripDraftText(normalized, { draftAsked: draftAsked && !sendRequest })
  const hasDraft = scanned !== normalized.replace(CODE_FENCE, '\n').replace(BLOCKQUOTE, '').replace(QUOTED, '""').replace(RELAYED_NOTES, '\n')
  const flags: RegexFlag[] = []
  for (const raw of scanned.split(CLAUSE_BREAK)) {
    const clause = raw.replace(/^[\s"'(*•>-]+/, '').trimEnd()
    if (!clause || clause.endsWith('?')) continue // a question isn't a claim
    // On a send-request turn ("send it", "book a showing ...") a
    // cited source doesn't excuse a claim ("Booked for Thursday, per the agent's
    // availability"); on other turns it is inbox or CRM talk.
    const inboxSource = !sendRequest && INBOX_SOURCE.test(clause)
    const taken: Array<[number, number]> = []
    const add = (start: number, match: string) => {
      const end = start + match.length
      if (taken.some(([s, e]) => start < e && end > s)) return // one flag per span
      taken.push([start, end])
      flags.push({ pattern: ACTION_CLAIM, match: match.trim() })
    }
    if (sendRequest && !inboxSource) {
      for (const re of hasDraft ? AFTER_SEND_REQUEST : [...AFTER_SEND_REQUEST, ACK_ONLY]) {
        const m = re.exec(clause)
        if (m) add(0, m[0])
      }
    }
    for (const p of CLAIM_PATTERNS) {
      if (inboxSource && !p.firstPerson) continue
      if (p.sendRequestOnly && !sendRequest) continue
      if (p.anchored) {
        const m = p.regex.exec(clause)
        if (m && !NEGATED_AFTER.test(clause.slice(m[0].length, m[0].length + 30))) add(0, m[0])
        continue
      }
      for (const m of clause.matchAll(p.regex)) {
        const start = m.index
        const end = start + m[0].length
        const prefix = clause.slice(Math.max(0, start - PREFIX_WINDOW), start).replace(NOT_A_NEGATION, '')
        if (NEGATION.test(prefix)) continue
        if (p.conditionalPasses && CONDITIONAL.test(prefix)) continue
        if (p.chatDisplayPasses && (CHAT_DISPLAY_BEFORE.test(prefix) || (/(?:sent|forwarded)$/.test(m[0]) && /^ you\b/.test(clause.slice(end))))) continue
        if (NEGATED_AFTER.test(clause.slice(end, end + 30))) continue
        add(start, m[0])
      }
    }
  }
  return flags
}
