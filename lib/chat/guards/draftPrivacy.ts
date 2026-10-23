// Brief 43 PR 3 (Q3; lead finding (c), spot #17): draft privacy.
//
// Drift drafts emails and texts for Ryan to copy and send himself; nothing is
// sent [Ryan, 2026-09-24]. A draft comes back in drift_response's `draft` field,
// apart from the reply text (lib/chat/draft.ts), and checkDraft holds it to the
// rules for anything sent:
//   - no homeowner name, phone or notes, and no words about the seller's
//     circumstances (fitReason's SELLER_CIRCUMSTANCES) [engineering precaution];
//   - no street address of a homeowner's home until the homeowner has agreed to
//     sell: the home is described by area and type (D12) [Ryan, 2026-10-19];
//   - no estimate of ours: our values stay out of anything a buyer or homeowner
//     could see [Ryan, 2026-10-17]. No other dollar figure, range or price hint
//     for a homeowner's home either: it reads "price on request", as the brief
//     and /matches drafts say (outreachPrice.ts) [engineering precaution]. A
//     listing's own asking price, as on its card, stays;
//   - to a homeowner: none of our values [Ryan, 2026-10-17], and no dollar figure
//     at all, nothing about how we found them and no pressure [engineering
//     precaution];
//   - signed "Ryan Martin" (D2, Brief 42 default), with no brokerage name or job
//     title [planner, 2026-10-19].
// The homeowners are the CRM sellers in this turn's tool results (collectHomeowners)
// plus any street address Ryan typed that isn't a listing found this turn
// (buildDraftContext). The chat route asks Drift for one rewrite with feedback,
// then falls back to `cleaned`, a deterministic clean-up (price replaced,
// offending sentences dropped, sign-off fixed), or declines (enforceDraftPrivacy).
import { normalizeStreet } from '../../crm-sync/addressNormalize'
import { extractAddressFromText } from '../../acris'
import { SELLER_CIRCUMSTANCES } from '../../matching/fitReason'
import { PRICE_ON_REQUEST } from '../../matching/outreachPrice'
import { normalizeDraft, type Draft, type DraftAudience, type DraftChannel } from '../draft'
import { readStoredReply } from '../storedReply'

export type { Draft, DraftAudience, DraftChannel } from '../draft'

// A CRM homeowner seen this turn (Brief 43 CONTRACT.md, "PR 3").
export interface HomeownerRef {
  name?: string | null
  phone?: string | null
  address?: string | null
  notes?: string | null
}

export interface DraftContext {
  homeowners: HomeownerRef[]
  typedAddresses: string[]
  listingAddresses: string[]
  // PR 3's one addition to the contract's shape (optional): the prices on this
  // turn's listing cards, so a listing's own asking price can stay in a draft.
  listingPrices?: number[]
  // Review r1 (optional): CRM sellers Drift was shown in its context block (up
  // to 20 at once until Brief 43 PR 5 makes that block counts only). Checked for
  // their name, phone, notes and address like `homeowners`, but they don't on
  // their own make a draft "about a homeowner" (that would flag every figure in
  // any draft written after a neighborhood question).
  contextHomeowners?: HomeownerRef[]
  // Review r1 (optional): Ryan asked for a message to a homeowner ("text the
  // owner"), so a draft not labelled buyer_side gets the homeowner rules.
  toHomeownerAsked?: boolean
  // Review r1 (optional): Ryan's message is about a homeowner's home ("about her
  // house", "one of my sellers"), so figures in the draft get the homeowner rule.
  homeownerHomeAsked?: boolean
  // Brief 43 PR 12 (optional): our estimate's figures (value, low, high) from this
  // turn's tools or said in an earlier reply. A draft never carries one, whoever it
  // is for and whatever else it is about: our values stay out of anything a buyer
  // or homeowner could see [Ryan, 2026-10-17]; D9 keeps them to chat.
  ourFigures?: number[]
}

export type DraftFlagKind =
  | 'homeowner_name' | 'homeowner_phone' | 'homeowner_notes' | 'street_address' | 'homeowner_price'
  | 'seller_circumstance' | 'how_we_found' | 'pressure' | 'brokerage_or_title' | 'signoff'

// `match` is the offending text, for Drift's rewrite feedback only. It can be a
// homeowner's name: never log it (telemetry keeps the kinds).
export interface DraftFlag { kind: DraftFlagKind; match: string }
export interface DraftCheck { flags: DraftFlag[]; cleaned: Draft | null }

// "price on request", the words /matches drafts and Buyer Match reports use for a
// homeowner (lib/matching/outreachPrice.ts).
export { PRICE_ON_REQUEST }
const SIGNOFF = 'Ryan Martin'

// Drift's reply line on a draft turn, and its reply when no safe draft is left.
export const DRAFT_READY_LINE = "Here's a draft for you to copy."
export const DRAFT_DECLINED_REPLY = "I couldn't write that draft without the homeowner's details, so I've left it out. I can write one that describes the home by area and type."

// A subject that carried a homeowner detail is replaced, in the clean-up only.
const NEUTRAL_SUBJECT: Record<DraftAudience, string> = {
  buyer_side: 'A home that may suit your buyer',
  homeowner: 'A question about your home',
  other: 'A quick note',
}

// ── The draft field on drift_response (the instructions Drift reads) ─────────
// Ryan's wording for spot #18 [Ryan, 2026-10-19]: one line, "I'll leave the
// number out; our values stay internal", then the draft itself.
export const DRAFT_FIELD_SCHEMA = {
  type: 'object',
  description:
    "Set only when Ryan asks you to draft an email or a text. Ryan copies it and sends it himself; nothing is sent. Put the whole message here, never in response: response is then one short line, such as \"Here's a draft for you to copy.\" If Ryan asked for a value or price for a homeowner's home in it, response is \"I'll leave the number out; our values stay internal.\" and the draft leaves it out. " +
    'Rules for every draft: describe a homeowner\'s home by area and type only ("a 3-family in Bed-Stuy"), with no street address until the homeowner has agreed to sell; no homeowner name, phone or notes; no estimate of ours and no price, range or value for a homeowner\'s home (write "price on request"); nothing about the seller\'s circumstances. A listing\'s own address and asking price may stay. ' +
    'To a homeowner: no dollar figure at all, nothing about how we found them, and low pressure. Sign off "Ryan Martin", with no brokerage name or job title.',
  properties: {
    channel: { type: 'string', enum: ['email', 'text'] },
    audience: {
      type: 'string',
      enum: ['buyer_side', 'homeowner', 'other'],
      description: "buyer_side: a buyer or a buyer's agent. homeowner: the owner of the home it's about. other: anyone else.",
    },
    subject: { type: 'string', description: 'Email subject line. Email only.' },
    body: { type: 'string', description: 'The whole message for Ryan to copy, in plain text.' },
  },
  required: ['channel', 'audience', 'body'],
} as const

// ── Small helpers ────────────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)]
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)

// ── Names ────────────────────────────────────────────────────────────────────
// The full name in either order ("Pat Example", "Example, Pat"), first and last
// without a middle name, the first name in a greeting ("Hi Pat,") and the last
// name with a title ("Ms. Example"). An LLC or trust is matched by its full name.
const ENTITY_WORD = /\b(?:llc|l\.l\.c|inc|corp|corporation|trust|holdings|realty|partners|estate|bank|associates|company|co)\b/i
const NB = '(?<![A-Za-z0-9])'
const NE = '(?![A-Za-z0-9])'
const GREETING = '(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))'
// `find` flags the name; `greeting` (the clean-up) turns "Hi Pat," into "Hi,".
// `byFirstName: false` (review r1) leaves out the first name in a greeting: for the
// CRM sellers Drift only had in its context, a buyer's agent may share one.
function namePatterns(name: string, byFirstName = true): { find: RegExp[]; greeting: RegExp | null } {
  const tokens = name.trim().split(/[\s,]+/).filter(Boolean)
  if (!tokens.length) return { find: [], greeting: null }
  const t = tokens.map(esc)
  const SEP = '[\\s,]+'
  const first = t[0]
  const last = t[t.length - 1]
  const find: RegExp[] = []
  let greeting: RegExp | null = null
  if (tokens.length >= 2 || tokens[0].length >= 4) find.push(new RegExp(`${NB}${t.join(SEP)}${NE}`, 'gi'))
  if (tokens.length >= 2) find.push(new RegExp(`${NB}${first}${SEP}${last}${NE}`, 'gi'), new RegExp(`${NB}${last}${SEP}${first}${NE}`, 'gi'))
  // Review r1: a middle name or initial the record doesn't carry ("Pat Q. Example").
  if (tokens.length >= 2) find.push(new RegExp(`${NB}${first}[ \\t]+[A-Za-z]{1,12}\\.?[ \\t]+${last}${NE}`, 'gi'))
  // Review r1: a person's last name as a family or possessive ("the Examples",
  // "Example's", "the Example family"), capitalised, at least four letters.
  const L = tokens[tokens.length - 1]
  if (tokens.length >= 2 && !ENTITY_WORD.test(name) && /^[A-Za-z][A-Za-z'-]{3,}$/.test(L)) {
    const forms = uniq([L[0].toUpperCase() + L.slice(1).toLowerCase(), L.toUpperCase()]).map(esc).join('|')
    find.push(new RegExp(`${NB}(?:[Tt]he[ \\t]+(?:${forms})s|(?:${forms})(?:['’]s|[ \\t]+(?:family|household)))${NE}`, 'g'))
  }
  if (!ENTITY_WORD.test(name) && /^[A-Za-z][A-Za-z'-]+$/.test(tokens[0])) {
    if (byFirstName) find.push(new RegExp(`^[ \\t]*${GREETING}[ \\t,]+${first}${NE}`, 'gim'))
    if (tokens.length >= 2) find.push(new RegExp(`${NB}(?:mr|mrs|ms|miss|mx|dr)\\.?[ \\t]+${last}${NE}`, 'gi'))
    greeting = new RegExp(`^([ \\t]*)${GREETING}[ \\t,]+(?:${t.join(SEP)}|${first})${NE}`, 'gim')
  }
  return { find, greeting }
}

// ── Phones ───────────────────────────────────────────────────────────────────
// CRM phones are stored as 10 raw digits; a draft may write them any way.
const PHONE = /(?<!\d)(?:\+?1[ .\-\u2010-\u2014]?)?(?:\(\d{3}\)|\d{3})[ .\-\u2010-\u2014]?\d{3}[ .\-\u2010-\u2014]?\d{4}(?!\d)|(?<!\d)\d{3}[ .\-\u2010-\u2014]\d{4}(?!\d)/g
function phoneDigits(s: string): string {
  const d = s.replace(/\D/g, '')
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d
}
function samePhone(hit: string, known: string): boolean {
  const h = phoneDigits(hit)
  const k = phoneDigits(known)
  if (k.length !== 10 && k.length !== 7) return false
  if (h.length === 10) return k.length === 10 ? h === k : h.slice(3) === k
  return h.length === 7 && k.slice(-7) === h
}

// ── Notes ────────────────────────────────────────────────────────────────────
// Five words in a row from a homeowner's notes.
function notesShingle(text: string, notes: string): string | null {
  const n = words(notes)
  if (n.length < 5) return null
  const hay = ` ${words(text).join(' ')} `
  for (let i = 0; i + 5 <= n.length; i++) {
    const shingle = n.slice(i, i + 5).join(' ')
    if (hay.includes(` ${shingle} `)) return shingle
  }
  return null
}

// ── Street addresses ─────────────────────────────────────────────────────────
// An address as its house number and street name (lib/crm-sync/addressNormalize,
// so "Ave"/"Avenue", "54th"/"54", "W"/"West" agree), without the street type:
// "88 Example Ave, Brooklyn" → "88 example". The house number must match exactly
// (88 is not 188).
const STREET_TYPES = new Set(['street', 'avenue', 'place', 'road', 'drive', 'boulevard', 'parkway', 'court', 'lane', 'terrace', 'highway', 'square', 'way'])
export function addressCore(address: string | null | undefined): string | null {
  const n = normalizeStreet((address ?? '').split(',')[0])
  if (!n) return null
  const t = n.split(' ')
  if (!/^\d+[a-z]?$/.test(t[0]) || t.length < 2) return null
  if (t.length > 2 && STREET_TYPES.has(t[t.length - 1])) t.pop()
  return t.join(' ')
}
// A house number: digits after a space or line start, not inside a figure.
const HOUSE_NUMBER = /(?<![\w$.,-])\d+(?:-\d+)?[A-Za-z]?(?=[ \t])/g

type Hit = { kind: DraftFlagKind; match: string; index: number }

function addressHits(text: string, cores: string[]): Hit[] {
  if (!cores.length) return []
  const hits: Hit[] = []
  for (const m of text.matchAll(HOUSE_NUMBER)) {
    const index = m.index ?? 0
    const window = text.slice(index, index + 120).split('\n')[0].split(/[ \t]+/).slice(0, 7)
    // Review r1: "#88 on Example Ave", "88 of Example Ave".
    if (/^(?:on|of)$/i.test(window[1] ?? '')) window.splice(1, 1)
    const n = normalizeStreet(window.join(' '))
    const core = n ? cores.find(c => `${n} `.startsWith(`${c} `)) : undefined
    if (core) hits.push({ kind: 'street_address', match: window.slice(0, core.split(' ').length + 1).join(' ').replace(/[.,;:!?]+$/, ''), index })
  }
  return hits
}

// ── Money ────────────────────────────────────────────────────────────────────
// "$1,250,000", "$1.4M", "$850K", "1.4 million", "2,100,000" (not "2,400 sq ft").
const MAG = 'k|mm|m|mil|million|thousand'
const MONEY_SRC = `(?:\\$[ \\t]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?(?:[ \\t]?(?:${MAG}|bn|b|billion)\\b)?|\\b\\d+(?:\\.\\d+)?[ \\t]?(?:${MAG})\\b|\\b\\d{1,3}(?:,\\d{3})+\\b(?![ \\t]?(?:sq|sf|square|ft|feet)))`
const MONEY = new RegExp(MONEY_SRC, 'gi')
// A price with the words before it, ending a clause, for the clean-up: "asking
// $1.4M.", "within the $2.1M to $3.3M range,", "The price is $1.4M." all become
// "price on request". A figure mid-clause ("your buyer's $2M budget") isn't
// replaced; its sentence is dropped instead.
const LEAD_IN = '(?:(?:at[ \\t]+)?(?:a[ \\t]+|the[ \\t]+)?(?:asking[ \\t]+)?price(?:[ \\t]+(?:is|of))?:?|(?:the[ \\t]+)?asking(?:[ \\t]+(?:of|is))?|list(?:ed|ing) at|priced(?:[ \\t]+(?:at|around))?|offered at|valued at|value of|worth(?:[ \\t]+(?:about|around|roughly))?|(?:is|are|was)(?:[ \\t]+(?:about|around|roughly))?|costs?|(?:goes|going|selling|sells|sold) for|around|about|roughly|approximately|near|in|within|between|at|for|under|over)'
const PRICE_PHRASE = new RegExp(`(?:\\b${LEAD_IN}[ \\t]+)?(?:the[ \\t]+)?${MONEY_SRC}(?:[ \\t]?(?:-|–|—|to|and)[ \\t]?${MONEY_SRC})?(?:[ \\t]+(?:[A-Za-z-]+[ \\t]+)?range\\b)?(?=[ \\t]?(?:[.,;:!?)](?!\\d)|$))`, 'gi')

function moneyValue(s: string): number | null {
  const m = /(\d[\d,]*(?:\.\d+)?)[ \t]?([a-z]+)?/i.exec(s)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(n)) return null
  const unit = (m[2] ?? '').toLowerCase()
  if (unit === 'k' || unit === 'thousand') return n * 1e3
  if (unit === 'm' || unit === 'mm' || unit === 'mil' || unit === 'million') return n * 1e6
  if (unit === 'b' || unit === 'bn' || unit === 'billion') return n * 1e9
  return n
}
// A listing's own price, allowing for rounding ("$1.3M" for $1,295,000).
const isListingPrice = (v: number | null, prices: number[]) => v != null && prices.some(p => p > 0 && Math.abs(v - p) <= p * 0.01)
// Brief 43 PR 12: a figure of our estimate's, with the same rounding ("$1.83M" for
// $1,834,000). Checked first, so it goes even when it equals a listing's price.
const isOurFigure = (v: number | null, ours: number[]) => isListingPrice(v, ours)
// A figure that reads "price on request" (or goes, to a homeowner).
const blockedFigure = (s: string, p: Prepared, homeowner: boolean) => {
  const v = moneyValue(s)
  return isOurFigure(v, p.ours) || (homeowner && !isListingPrice(v, p.prices))
}

// Review r1: a price hint with no "$" figure, in a draft about a homeowner's home
// [engineering precaution; the brief's "price on request"]: "about two million",
// "two and a half million", "a million", "in the low 2s", "mid-900s", "high twos",
// "seven figures". One digit (or three) before the "s", so "the mid 80s" or "the
// 1920s" (a building's era) isn't one.
const SPELLED = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)'
const PRICE_HINT = new RegExp([
  `\\b${SPELLED}(?:[ \\t-]+(?:point[ \\t]+${SPELLED}|and[ \\t]+a[ \\t]+half))?[ \\t]+(?:million|mil)\\b`,
  // Not "thanks a million", "one in a million", "a million thanks/times/reasons".
  '(?<!thanks |in )\\b(?:half a|a)[ \\t]+million\\b(?![ \\t]{1,3}(?:thanks|times|reasons|questions|ways|things))',
  "\\b(?:low|mid|high|upper)[ \\t-]+(?:\\$?(?:\\d(?:\\.\\d+)?|\\d{3})[mk]?['’]?s|ones|twos|threes|fours|fives|sixes|sevens|eights|nines|tens)\\b",
  '\\b(?:six|seven|eight)[ \\t-]+figures?\\b',
].join('|'), 'gi')
// "around 2.1" or "about 2" with no unit after it ("around 2 blocks", "about 3
// beds" and "around 2pm" aren't), counted only in a sentence about the price.
const BARE_FIGURE = /\b(?:around|about|roughly|approximately|approx\.?|maybe|close to|north of|south of|upwards of|at least|over|under|near)[ \t]+\d{1,2}(?:\.\d{1,2})?(?!\d|[.,]\d|[ \t]{0,3}(?:%|percent|[A-Za-z]))/gi
// Review r2: a whole hour with words about meeting ("free around 5", "talk about
// selling, maybe around 4?") is a time, not a price; a decimal ("around 2.1") still counts.
const TIME_WORD = /\b(?:free|meet|call|talk|chat|speak|available|time|today|tonight|tomorrow|morning|afternoon|evening|o['’]?clock|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|week)\b/i
const PRICE_WORD = /\b(?:worth|take|accept\w*|bids?|valu\w*|price\w*|sell\w*|sale|sold|go(?:es|ing)? for|fetch\w*|get for|list\w*|asking|ask|offers?|market|trade\w*|apprais\w*|number)\b/i
// The sentence around a match (at most 200 characters each way, so it stays linear).
function sentenceAround(text: string, at: number, len: number): string {
  const back = Math.max(0, at - 200)
  const from = back + text.slice(back, at).lastIndexOf('\n') + 1
  let start = from
  for (const m of text.slice(from, at).matchAll(/[.!?][ \t]+/g)) start = from + (m.index ?? 0) + m[0].length
  const after = text.slice(at + len, at + len + 200)
  const end = after.search(/[.!?](?:[ \t]|$)|\n/)
  return text.slice(start, at + len + (end < 0 ? after.length : end))
}

// ── Words ────────────────────────────────────────────────────────────────────
const CIRCUMSTANCES = new RegExp(SELLER_CIRCUMSTANCES.source, 'gi')
const HOW_WE_FOUND = /\b(?:public records?|property records?|city records?|ACRIS|PLUTO|records show|(?:our|my) (?:records|data|database|system|lists?|crm)|the crm|DealFlow|Drift|Mojo|(?:we|I) (?:found|came across|pulled up) (?:you|your)|on (?:a|our|my) list)\b/gi
const PRESSURE = /\b(?:act (?:now|fast|quickly)|urgent(?:ly)?|limited time|don[’']?t miss|before it[’']?s too late|time is running out|now is the (?:best |right )?time|must sell|need to sell|you should sell|last chance|asap)\b/gi
// Review r1: a homeowner's motivation in words fitReason's list doesn't have, for a
// draft about a homeowner's home, to anyone (buyer-facing text never names a
// homeowner's motivation [engineering precaution]).
const MOTIVATION = /\b(?:must sell|needs? to sell|has to sell|have to sell|eager to sell|anxious to sell|wants? out|quick sale|sell(?:ing)? (?:fast|quickly)|priced to sell|below market|desperate|needs? (?:the )?(?:cash|money)|ill(?:ness)?|sick|health (?:issues?|problems?|reasons)|elderly|assisted living|nursing home|hospice|lost (?:his|her|their) job|job loss|(?:owner|seller|family)s? (?:is |are )?relocating)\b/gi
// Review r1: a draft that talks to the reader about their own home.
const YOUR_HOME = /\byour (?:home|house|property|building|brownstone|townhouse|place|[1-6]-family)\b/i
// The brokerage name the old prompt used (N10), and Ryan describing himself by a job title.
const BROKERAGE = /\bDouglas[ \t]+Elliman\b(?:[ \t]+Real[ \t]+Estate)?/gi
const BROKERAGE_PHRASE = /[ \t]*(?:,[ \t]*|\b(?:with|from|at|of|here at)[ \t]+)?\bDouglas[ \t]+Elliman\b(?:[ \t]+Real[ \t]+Estate)?/gi
const SELF_TITLE = /\b(?:I'm|I’m|I am|as)[ \t]+(?:a|an|your)[ \t]+(?:[A-Za-z-]+[ \t]+){0,3}?(?:broker|agent|salesperson|realtor)s?\b/gi
// Words that say a draft is about a home that isn't listed, when no homeowner
// was seen this turn (Drift can still have one from earlier in the chat).
const HOMEOWNER_CUE = /\b(?:homeowners?|off[- ]market|not (?:yet )?listed|isn[’']?t listed|not on the market|(?:may|might|could) sell|open to selling|consider(?:ing)? selling|thinking (?:about|of) selling)\b/i

// ── Sign-off ─────────────────────────────────────────────────────────────────
const CLOSING = '(?:best(?:[ \\t]+regards)?|kind regards|warm regards|regards|warmly|thanks|thank you|many thanks|cheers|sincerely|talk soon|all the best)'
const SIGNOFF_LINE = new RegExp(`^([ \\t]*(?:[-–—~][ \\t]*)?(?:${CLOSING}[,.!]?[ \\t]+)?)Ryan\\b(.*)$`, 'i')
const INLINE_SIGNOFF = new RegExp(`^(.*[.!?])[ \\t]+((?:${CLOSING}[,.!]?[ \\t]+)?)(?:[-–—~][ \\t]*)?Ryan\\b(.*)$`, 'i')
const CLOSING_LINE = new RegExp(`^${CLOSING}[,.!]?$`, 'i')
// After "Ryan" on a sign-off line: nothing, "Martin", or a separator before a
// brokerage, title or contact ("Ryan Martin, <brokerage>", "Ryan | <title>").
function signoffTail(tail: string): boolean {
  return /^(?:[ \t]+Martin\b)?[ \t]*(?:$|[,|/•·(–—-])/i.test(tail) && !tail.includes('?') && tail.trim().split(/\s+/).length <= 12
}
// A brokerage, title, phone or email line under the name.
function signatureExtra(line: string): boolean {
  const t = line.trim()
  return !t || (t.split(/\s+/).length <= 8 && !t.includes('?') && !/[.!][ \t]+\S/.test(t))
}

// Signed "Ryan Martin" (D2), with no brokerage name or job title [planner,
// 2026-10-19]: "Ryan", "- Ryan", "Ryan Martin, <brokerage>" and the lines under
// it become "Ryan Martin"; a closing ("Best,", "Thanks,") stays. A draft with no
// sign-off gets one, unless it already names Ryan Martin ("Hi, this is Ryan
// Martin.").
export function fixSignoff(body: string, channel: DraftChannel): { body: string; changed: boolean; match: string } {
  const lines = body.split('\n')
  let end = lines.length
  while (end > 0 && !lines[end - 1].trim()) end--
  for (let i = end - 1; i >= Math.max(0, end - 5); i--) {
    const m = SIGNOFF_LINE.exec(lines[i])
    if (!m || !signoffTail(m[2]) || !lines.slice(i + 1, end).every(signatureExtra)) continue
    const fixed = `${m[1].replace(/[-–—~][ \t]*/, '').trimStart()}${SIGNOFF}`
    const was = lines.slice(i, end).join('\n')
    const changed = was !== fixed
    return { body: changed ? [...lines.slice(0, i), fixed].join('\n') : body, changed, match: changed ? was.trim() : '' }
  }
  const last = end > 0 ? lines[end - 1] : ''
  const im = INLINE_SIGNOFF.exec(last)
  if (im && signoffTail(im[3])) {
    const fixed = `${im[1]} ${im[2]}${SIGNOFF}`
    const changed = fixed !== last
    return { body: changed ? [...lines.slice(0, end - 1), fixed].join('\n') : body, changed, match: changed ? last.slice(im[1].length).trim() : '' }
  }
  if (/\bRyan Martin\b/.test(body)) return { body, changed: false, match: '' }
  return { body: `${lines.slice(0, end).join('\n')}${channel === 'email' ? '\n\n' : '\n'}${SIGNOFF}`, changed: true, match: '(no sign-off)' }
}

// ── The check ────────────────────────────────────────────────────────────────
interface Prepared {
  homeowners: HomeownerRef[]
  // A homeowner seen this turn, a typed address, or Ryan asking about a
  // homeowner's home: the draft is taken to be about a homeowner's home.
  anchored: boolean
  names: RegExp[]
  greetings: RegExp[]
  phones: string[]
  notes: string[]
  cores: string[]
  prices: number[]
  ours: number[]
}

function prepare(ctx: DraftContext): Prepared {
  const homeowners = ctx.homeowners ?? []
  // Review r1: sellers from the context block or an earlier turn are checked for
  // their details too (identity), without anchoring the draft.
  const identity = [...homeowners, ...(ctx.contextHomeowners ?? [])]
  const listingCores = new Set((ctx.listingAddresses ?? []).map(addressCore).filter((c): c is string => !!c))
  const homeownerCores = homeowners.map(h => addressCore(h.address)).filter((c): c is string => !!c)
  const contextCores = (ctx.contextHomeowners ?? []).map(h => addressCore(h.address)).filter((c): c is string => !!c)
  // A typed address may stay when it's a listing found this turn (public),
  // unless it's also a homeowner's.
  const typedCores = (ctx.typedAddresses ?? []).map(addressCore).filter((c): c is string => !!c && !listingCores.has(c))
  const names = identity.map((h, i) => (h.name ? namePatterns(h.name, i < homeowners.length) : { find: [], greeting: null }))
  return {
    homeowners,
    anchored: homeowners.length > 0 || homeownerCores.length > 0 || typedCores.length > 0 || !!ctx.homeownerHomeAsked,
    names: names.flatMap(n => n.find),
    greetings: names.map(n => n.greeting).filter((g): g is RegExp => !!g),
    phones: identity.map(h => h.phone ?? '').filter(Boolean),
    notes: identity.map(h => h.notes ?? '').filter(Boolean),
    cores: uniq([...homeownerCores, ...typedCores, ...contextCores]),
    prices: ctx.listingPrices ?? [],
    ours: ctx.ourFigures ?? [],
  }
}

const aboutHomeowner = (d: Draft, p: Prepared) =>
  p.anchored || HOMEOWNER_CUE.test(`${d.subject ?? ''}\n${d.body}`)
const IDENTITY = new Set<DraftFlagKind>(['homeowner_name', 'homeowner_phone', 'homeowner_notes', 'street_address'])

// Review r1: the homeowner rules don't rest on Drift's label alone. A draft
// labelled "other" that talks about the reader's home, or one Ryan asked to send
// a homeowner ("text the owner"), is checked as one to a homeowner; so is a
// "buyer_side" one when both are true [engineering precaution].
export function effectiveAudience(d: Draft, ctx: Pick<DraftContext, 'toHomeownerAsked'>): DraftAudience {
  if (d.audience === 'homeowner') return 'homeowner'
  const yours = YOUR_HOME.test(`${d.subject ?? ''}\n${d.body}`)
  if (d.audience === 'other') return yours || ctx.toHomeownerAsked ? 'homeowner' : 'other'
  return yours && ctx.toHomeownerAsked ? 'homeowner' : d.audience
}

function scan(text: string, audience: DraftAudience, p: Prepared, homeowner: boolean): Hit[] {
  const hits: Hit[] = []
  const all = (kind: DraftFlagKind, re: RegExp) => {
    for (const m of text.matchAll(re)) hits.push({ kind, match: m[0].trim(), index: m.index ?? 0 })
  }
  for (const re of p.names) all('homeowner_name', re)
  for (const m of text.matchAll(PHONE)) {
    if (p.phones.some(k => samePhone(m[0], k))) hits.push({ kind: 'homeowner_phone', match: m[0], index: m.index ?? 0 })
  }
  for (const n of p.notes) {
    const shingle = notesShingle(text, n)
    if (shingle) hits.push({ kind: 'homeowner_notes', match: shingle, index: -1 })
  }
  hits.push(...addressHits(text, p.cores))
  if (homeowner) all('seller_circumstance', MOTIVATION)
  for (const m of text.matchAll(MONEY)) {
    if (audience === 'homeowner' || blockedFigure(m[0], p, homeowner)) {
      hits.push({ kind: 'homeowner_price', match: m[0].trim(), index: m.index ?? 0 })
    }
  }
  if (audience === 'homeowner' || homeowner) {
    all('homeowner_price', PRICE_HINT)
    for (const m of text.matchAll(BARE_FIGURE)) {
      const sentence = sentenceAround(text, m.index ?? 0, m[0].length)
      const hour = /^\D*(?:[1-9]|1[0-2])$/.test(m[0].trim()) && TIME_WORD.test(sentence)
      if (!hour && PRICE_WORD.test(sentence)) hits.push({ kind: 'homeowner_price', match: m[0].trim(), index: m.index ?? 0 })
    }
  }
  all('seller_circumstance', CIRCUMSTANCES)
  if (audience === 'homeowner') {
    all('how_we_found', HOW_WE_FOUND)
    all('pressure', PRESSURE)
  }
  all('brokerage_or_title', BROKERAGE)
  all('brokerage_or_title', SELF_TITLE)
  return hits
}

function dedupeFlags(flags: DraftFlag[]): DraftFlag[] {
  const seen = new Set<string>()
  return flags.filter(f => {
    const key = `${f.kind}\u0000${f.match.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Check a draft against this turn's homeowners and typed addresses. `flags` lists
 * every rule it breaks; `cleaned` is the deterministic clean-up (the draft itself
 * when nothing is flagged), or null when no safe draft is left.
 */
export function checkDraft(original: Draft, ctx: DraftContext): DraftCheck {
  const p = prepare(ctx)
  // Checked with the audience it really has; the label shown stays Drift's.
  const draft: Draft = { ...original, audience: effectiveAudience(original, ctx) }
  const all = `${draft.subject ?? ''}\n${draft.body}`
  // A draft that names a homeowner (or gives their phone or address) is about them.
  const homeowner = aboutHomeowner(draft, p) || scan(all, draft.audience, p, false).some(h => IDENTITY.has(h.kind))
  const signed = fixSignoff(draft.body, draft.channel)
  const hits = [...(draft.subject ? scan(draft.subject, draft.audience, p, homeowner) : []), ...scan(signed.body, draft.audience, p, homeowner)]
  const flags = dedupeFlags(hits.map(({ kind, match }) => ({ kind, match })))
  if (signed.changed) flags.push({ kind: 'signoff', match: signed.match })
  const label = (d: Draft | null): Draft | null => (d ? { ...d, audience: original.audience } : null)
  if (!flags.length) return { flags, cleaned: original }
  if (!hits.length) return { flags, cleaned: label({ ...draft, body: signed.body }) }
  return { flags, cleaned: label(cleanDraft({ ...draft, body: signed.body }, p, homeowner)) }
}

// ── The clean-up ─────────────────────────────────────────────────────────────
// Sentence pieces of a line, not split after "St.", "Ave.", "Ms." or an initial.
const ABBREV_END = /(?:^|[^A-Za-z])(?:St|Ave|Mr|Mrs|Ms|Dr|Jr|Sr|Pl|Rd|Blvd|Apt|No|[A-Z])$/
function segments(line: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  let start = 0
  for (const m of line.matchAll(/[.!?]+(?=[ \t])/g)) {
    const at = m.index ?? 0
    if (m[0] === '.' && ABBREV_END.test(line.slice(Math.max(start, at - 5), at))) continue
    out.push({ start, end: at + m[0].length })
    start = at + m[0].length
  }
  if (start < line.length) out.push({ start, end: line.length })
  return out
}

function replacePrices(line: string, p: Prepared, homeowner: boolean): string {
  const parts: string[] = []
  let last = 0
  for (const m of line.matchAll(PRICE_PHRASE)) {
    if (![...m[0].matchAll(MONEY)].some(f => blockedFigure(f[0], p, homeowner))) continue
    const at = m.index ?? 0
    let before = line.slice(last, at)
    // "in Bed-Stuy around $1.9M." → "in Bed-Stuy, price on request." (The text
    // before is read from `line`, never from the parts, so this stays linear.)
    if (/[A-Za-z0-9)][ \t]+$/.test(line.slice(Math.max(0, last - 1), at))) before = before.replace(/[ \t]+$/, ', ')
    parts.push(before, PRICE_ON_REQUEST)
    last = at + m[0].length
  }
  return (parts.join('') + line.slice(last))
    .replace(new RegExp(`${PRICE_ON_REQUEST}(?:[ \\t]*(?:,|and|or|to|-)[ \\t]*${PRICE_ON_REQUEST})+`, 'gi'), PRICE_ON_REQUEST)
    .replace(/(^[ \t]*|[.!?][ \t]+)price on request/g, (_m, lead: string) => `${lead}Price on request`)
}

function cleanLine(line: string, audience: DraftAudience, p: Prepared, homeowner: boolean): string {
  // "Hi Pat," → "Hi,"
  let l = p.greetings.reduce((s, re) => s.replace(re, '$1Hi'), line).replace(BROKERAGE_PHRASE, '')
  // To a buyer's side the price reads "price on request"; to a homeowner the
  // sentence with a figure goes (there's no price to put there).
  if (audience !== 'homeowner') l = replacePrices(l, p, homeowner)
  const hits = scan(l, audience, p, homeowner)
  if (!hits.length) return l
  // Drop each sentence a hit starts in (both lists are in order: one pass).
  const at = hits.map(h => h.index).filter(i => i >= 0).sort((a, b) => a - b)
  let k = 0
  return segments(l)
    .filter(s => {
      while (k < at.length && at[k] < s.start) k++
      return !(k < at.length && at[k] < s.end)
    })
    .map(s => l.slice(s.start, s.end))
    .filter(piece => !p.notes.some(n => notesShingle(piece, n)))
    .map(piece => piece.trim())
    .filter(Boolean)
    .join(' ')
}

function tidy(text: string): string {
  return text
    .split('\n')
    .map(l => l.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([,.!?])/g, '$1').replace(/,([.!?])/g, '$1').replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Anything left besides a greeting, a closing and the sign-off.
const GREETING_LINE = /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))\b[^.!?\n]{0,40}[,.!]?$/i
function hasSubstance(body: string): boolean {
  const content = body.split('\n').map(l => l.trim())
    .filter(l => l && !GREETING_LINE.test(l) && !CLOSING_LINE.test(l) && !SIGNOFF_LINE.test(l))
  return content.join(' ').split(/\s+/).filter(Boolean).length >= 4
}

function cleanDraft(draft: Draft, p: Prepared, homeowner: boolean): Draft | null {
  const lines = draft.body.split('\n').map(l => cleanLine(l, draft.audience, p, homeowner))
  const body = fixSignoff(tidy(lines.join('\n')), draft.channel).body
  const subject = draft.subject !== undefined && scan(draft.subject, draft.audience, p, homeowner).length
    ? NEUTRAL_SUBJECT[draft.audience]
    : draft.subject
  const out: Draft = { ...draft, ...(subject !== undefined ? { subject } : {}), body }
  const left = [...scan(out.body, out.audience, p, homeowner), ...(out.subject ? scan(out.subject, out.audience, p, homeowner) : [])]
  return left.length || !hasSubstance(out.body) ? null : out
}

// ── What this turn saw ───────────────────────────────────────────────────────
// One of this turn's tool results, as the route keeps them for the guard
// (llmVerifier's ToolResultForVerify).
type ToolOutput = { name?: string; input?: unknown; output: unknown }

// Today's Mojo party card is titled "<name> — <neighborhood>", or "<name> —
// <address>" when it has no neighborhood (lib/chat/tools/searchParties.ts).
function addressFromTitle(title: unknown): string | null {
  const t = typeof title === 'string' ? title : ''
  const at = t.lastIndexOf(' — ')
  const tail = at >= 0 ? t.slice(at + 3).trim() : ''
  return /^\d/.test(tail) ? tail : null
}

/**
 * The CRM homeowners in this turn's tool outputs: any object with
 * `kind: 'crm_seller'` (find_seller's match, get_seller_matches' seller; Brief 43
 * PR 5/6), plus today's search_parties card with `category: 'MOJO_LEAD'`.
 */
export function collectHomeowners(toolResults: ReadonlyArray<ToolOutput>): HomeownerRef[] {
  const found: HomeownerRef[] = []
  const seen = new Set<object>()
  const visit = (v: unknown, depth: number): void => {
    if (!v || typeof v !== 'object' || depth > 8 || seen.has(v)) return
    seen.add(v)
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return }
    const o = v as Record<string, unknown>
    if (o.kind === 'crm_seller' || o.category === 'MOJO_LEAD') {
      found.push({
        name: str(o.name),
        phone: str(o.phone),
        address: str(o.address) ?? (o.category === 'MOJO_LEAD' ? addressFromTitle(o.title) : null),
        notes: str(o.notes),
      })
    }
    for (const x of Object.values(o)) visit(x, depth + 1)
  }
  for (const r of toolResults) visit(r.output, 0)
  const keys = new Set<string>()
  return found.filter(h => {
    const key = JSON.stringify([h.name, h.phone, h.address, h.notes])
    if (keys.has(key)) return false
    keys.add(key)
    return true
  })
}

// Every street address in a message (lib/acris's extractor finds the first).
function addressesIn(text: string): string[] {
  const out: string[] = []
  let rest = text
  for (let i = 0; i < 10 && rest; i++) {
    const found = extractAddressFromText(rest)
    if (!found) break
    out.push(found)
    const num = found.split(' ')[0]
    const at = rest.search(new RegExp(`(?<![\\d-])${esc(num)}(?![\\d-])`))
    if (at < 0) break
    rest = rest.slice(at + num.length)
  }
  return out
}

// Review r1: the listing categories search_listings returns (the rows a reply's
// dealsJson keeps), so a buyer's budget never passes as a listing's price.
const LISTING_CATEGORIES = new Set(['COMING_SOON_SALE', 'OFF_MARKET_SALE', 'ACTIVE_SALE_LISTING', 'COMING_SOON_RENTAL', 'RENTAL_LISTING'])
// Review r1: Ryan asks for a message to a homeowner, or about a homeowner's home.
const TO_HOMEOWNER_ASK = /\b(?:text|email|e-mail|message|write|letter|note|reach out|draft)\b[^.?!\n]{0,40}\b(?:home ?owners?|owners?)\b(?!['’]s)/i
const ABOUT_HOMEOWNER_ASK = /\b(?:(?:her|his|their|the (?:home ?)?owner['’]?s?|the seller['’]?s?)[ \t]+(?:house|home|place|property|building)|(?:one of )?(?:my|your) (?:crm )?sellers?)\b/i

// Review r1: today's CRM context block (lib/chat/context/mojo.ts) lists up to 20
// sellers as "[MOJO:id] name | street, city | area | ... | ph: phone | notes: ...".
// Drift can draft from it with no tool call, so its sellers are checked too. Brief
// 43 PR 5 makes the block counts only; this then finds nothing.
export function homeownersInContextBlock(block: string | null | undefined): HomeownerRef[] {
  const out: HomeownerRef[] = []
  for (const line of (block ?? '').split('\n')) {
    const m = /^\[MOJO:[^\]]*\][ \t]*(.*)$/.exec(line.trim())
    if (!m) continue
    const parts = m[1].split(' | ')
    out.push({
      name: str(parts[0]),
      address: str((parts[1] ?? '').split(',')[0]),
      phone: str(parts.find(x => x.startsWith('ph: '))?.slice(4)),
      notes: str(parts.find(x => x.startsWith('notes: '))?.slice(7)),
    })
  }
  return out
}

// Brief 43 PR 12: our estimate's figures, from any `internalEstimate` in this
// turn's tool results (find_seller's match, get_seller_matches' seller;
// lib/chat/valuation.ts) ...
function estimateFigures(toolResults: ReadonlyArray<ToolOutput>): number[] {
  const out: number[] = []
  const seen = new Set<object>()
  const visit = (v: unknown, depth: number): void => {
    if (!v || typeof v !== 'object' || depth > 8 || seen.has(v)) return
    seen.add(v)
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return }
    const o = v as Record<string, unknown>
    const e = o.internalEstimate
    if (e && typeof e === 'object') {
      for (const k of ['value', 'low', 'high']) {
        const n = (e as Record<string, unknown>)[k]
        if (typeof n === 'number' && n > 0) out.push(n)
      }
    }
    for (const x of Object.values(o)) visit(x, depth + 1)
  }
  for (const r of toolResults) visit(r.output, 0)
  return out
}

// ... and every figure in a sentence of an earlier reply that names an estimate
// ("Our internal estimate is $1.83M, likely $1.52M–$2.14M, as of Oct 1."), so a
// draft asked for a turn later can't carry it either [engineering precaution].
const ESTIMATE_WORD = /\bestimate/gi
function estimateFiguresSaid(history: ReadonlyArray<{ role: string; content: string }>): number[] {
  const out: number[] = []
  for (const m of history) {
    if (m.role !== 'assistant') continue
    const text = readStoredReply(m.content ?? '').response
    for (const w of text.matchAll(ESTIMATE_WORD)) {
      for (const f of sentenceAround(text, w.index ?? 0, w[0].length).matchAll(MONEY)) {
        const v = moneyValue(f[0])
        if (v != null && v > 0) out.push(v)
      }
    }
  }
  return out
}

/**
 * What a draft is checked against this turn: the CRM homeowners in the tool
 * outputs, the street addresses Ryan typed (this message and his earlier turns
 * in the loaded history), and the listings search_listings found (address and
 * price, which may stay in a draft).
 */
export function buildDraftContext(input: {
  toolResults: ReadonlyArray<ToolOutput>
  userMessage: string
  // Review r1: the stored rows, with each reply's dealsJson.
  history: ReadonlyArray<{ role: string; content: string; dealsJson?: unknown }>
  // Review r1: the turn's context block (the CRM sellers it lists are checked too).
  contextBlock?: string | null
}): DraftContext {
  const listingAddresses: string[] = []
  const listingPrices: number[] = []
  // Review r1: listings and CRM seller cards shown earlier in this chat (each
  // reply's dealsJson: the listing rows the page showed, and Brief 43 PR 5's seller
  // cards). A listing discussed a turn ago keeps its address and price; a seller
  // looked up a turn ago is still checked for their details.
  const earlier = input.history
    .filter(m => m.role === 'assistant' && Array.isArray(m.dealsJson))
    .flatMap(m => m.dealsJson as unknown[])
  for (const c of earlier) {
    if (!c || typeof c !== 'object') continue
    const row = c as Record<string, unknown>
    if (!LISTING_CATEGORIES.has(String(row.category))) continue
    const address = str(row.address)
    if (address) listingAddresses.push(address)
    for (const k of ['price', 'minPrice', 'maxPrice']) if (typeof row[k] === 'number') listingPrices.push(row[k] as number)
  }
  for (const r of input.toolResults) {
    if (r.name !== 'search_listings') continue
    const cards = (r.output as { cards?: unknown } | null)?.cards
    for (const c of Array.isArray(cards) ? cards as Array<Record<string, unknown>> : []) {
      const address = str(c.address)
      if (address) listingAddresses.push(address)
      if (typeof c.price === 'number') listingPrices.push(c.price)
      if (Array.isArray(c.priceRange)) listingPrices.push(...c.priceRange.filter((x): x is number => typeof x === 'number'))
    }
  }
  const typed = [input.userMessage, ...input.history.filter(m => m.role === 'user').map(m => m.content)]
  return {
    homeowners: collectHomeowners(input.toolResults),
    typedAddresses: uniq(typed.flatMap(t => addressesIn(t ?? ''))),
    listingAddresses: uniq(listingAddresses),
    listingPrices,
    contextHomeowners: [...collectHomeowners([{ output: earlier }]), ...homeownersInContextBlock(input.contextBlock)],
    toHomeownerAsked: TO_HOMEOWNER_ASK.test(input.userMessage ?? ''),
    homeownerHomeAsked: ABOUT_HOMEOWNER_ASK.test(input.userMessage ?? ''),
    ourFigures: uniq([...estimateFigures(input.toolResults), ...estimateFiguresSaid(input.history)]),
  }
}

// ── The route's flow ─────────────────────────────────────────────────────────
const FLAG_TEXT: Record<Exclude<DraftFlagKind, 'signoff'>, (m: string) => string> = {
  homeowner_name: m => `the homeowner's name ("${m}")`,
  homeowner_phone: () => "the homeowner's phone number",
  homeowner_notes: m => `the homeowner's notes ("${m}")`,
  street_address: m => `the street address ("${m}")`,
  homeowner_price: m => `the price or value "${m}"`,
  seller_circumstance: m => `"${m}" (the seller's circumstances)`,
  how_we_found: m => `"${m}" (how we found them)`,
  pressure: m => `"${m}" (pressure)`,
  brokerage_or_title: m => `"${m}" (a brokerage name or job title)`,
}

// The user turn of the one rewrite: what to take out, and the rules again.
export function buildDraftFeedbackPrompt(flags: DraftFlag[], audience: DraftAudience): string {
  const lines = uniq(flags.filter(f => f.kind !== 'signoff').map(f => FLAG_TEXT[f.kind as Exclude<DraftFlagKind, 'signoff'>](f.match)))
  const price = audience === 'homeowner'
    ? 'In a message to the homeowner put no dollar figure or value at all, nothing about how we found them, and keep it low pressure.'
    : `Write "${PRICE_ON_REQUEST}" for a homeowner's home.`
  return `Your draft can't go to anyone as written. Take out:
${lines.map(l => `- ${l}`).join('\n')}

Write it again in drift_response's draft field. Describe a homeowner's home by area and type only (for example "a 3-family in Bed-Stuy"), with no street address. ${price} Leave out the homeowner's name, phone and notes and anything about their circumstances. Sign it "${SIGNOFF}" with no brokerage name or job title. A listing's own address and asking price may stay. Keep response to one short line and don't repeat the draft there.`
}

// The previous draft as the assistant turn the rewrite answers.
export function draftAsText(response: string, draft: Draft): string {
  return [response, '', `Draft (${draft.channel}, ${draft.audience}):`, ...(draft.subject ? [`Subject: ${draft.subject}`] : []), draft.body].join('\n').trim()
}

// Eight words in a row from a draft: the reply repeats it.
const eightWordRuns = (s: string): string[] => {
  const w = words(s)
  const out: string[] = []
  for (let i = 0; i + 8 <= w.length; i++) out.push(w.slice(i, i + 8).join(' '))
  return out
}
function repeatsDraft(response: string, drafts: Draft[]): boolean {
  const said = new Set(eightWordRuns(response))
  return said.size > 0 && drafts.some(d => eightWordRuns(d.body).some(run => said.has(run)))
}

// Review r1: a draft written into the reply instead of the draft field (Stage 1's
// #17 shape). From a "Subject:" or greeting line to Ryan's sign-off, it's lifted
// out and checked like any draft, so the rules don't rest on Drift using the
// field [engineering precaution]. Both ends are needed: a greeting with no
// sign-off (or the reverse) is ordinary reply text.
const INLINE_START = /^[ \t]*(?:subject[ \t]*:|(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))\b(?![ \t,]*ryan\b))/i
// Only "Ryan" or "Ryan Martin", maybe with a short brokerage or title after it.
// Case-sensitive, and never "I ...", so a reply that addresses Ryan ("Good
// morning. Ryan, three listings came in." / "Ryan, I have news.") isn't a sign-off.
const LIFT_TAIL = /^(?:[ \t]+[Mm]artin\b)?[ \t]*[.!]?(?:[ \t]*[,|][ \t]*(?!I\b|I['’])[A-Z][A-Za-z&.' ]{0,40})?[ \t]*$/
// A one-line text needs a closing ("Thanks, Ryan") or the full name to count.
const ONE_LINE_SIGNED = (closing: string, tail: string) => !!closing.trim() || /^[ \t]+[Mm]artin\b/.test(tail)
export function liftInlineDraft(response: string, ctx?: Pick<DraftContext, 'toHomeownerAsked'>): { draft: Draft; reply: string } | null {
  const lines = response.replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex(l => INLINE_START.test(l))
  if (start < 0) return null
  let end = -1
  for (let i = lines.length - 1; i > start && end < 0; i--) {
    const m = SIGNOFF_LINE.exec(lines[i])
    const im = INLINE_SIGNOFF.exec(lines[i])
    if ((m && LIFT_TAIL.test(m[2])) || (im && LIFT_TAIL.test(im[3]))) end = i
  }
  if (end < 0) {
    // A one-line text: "Hi, this is Ryan Martin. ... Thanks, Ryan"
    const im = INLINE_SIGNOFF.exec(lines[start])
    if (im && LIFT_TAIL.test(im[3]) && ONE_LINE_SIGNED(im[2], im[3]) && !/^[ \t]*subject/i.test(lines[start])) end = start
    else return null
  }
  const sm = /^[ \t]*subject[ \t]*:[ \t]*(.*)$/i.exec(lines[start])
  const subject = sm ? sm[1].trim() || undefined : undefined
  const body = lines.slice(sm ? start + 1 : start, end + 1).join('\n').trim()
  const draft = normalizeDraft({ channel: subject ? 'email' : 'text', audience: ctx?.toHomeownerAsked ? 'homeowner' : 'other', subject, body })
  if (!draft) return null
  const reply = [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { draft, reply: reply || DRAFT_READY_LINE }
}

export type DraftOutcome = 'none' | 'clean' | 'signoff_fixed' | 'rewritten' | 'cleaned' | 'declined'
export interface DraftPrivacyResult {
  draft: Draft | null
  response: string
  outcome: DraftOutcome
  flagKinds: DraftFlagKind[] // what the first check flagged: kinds only, never the text
  rewrote: boolean
}

const needsRewrite = (flags: DraftFlag[]) => flags.some(f => f.kind !== 'signoff')

/**
 * The route's flow for one turn's draft. A clean draft (or one whose sign-off
 * only needs fixing) passes. A flagged one gets one rewrite with feedback
 * (`rewrite`, a forced drift_response), then the deterministic clean-up of the
 * rewrite (or of the first draft), or a decline with a short note. The reply
 * becomes one short line when it repeats the draft. `allowRewrite: false` skips
 * the rewrite (for a turn short on time).
 */
export async function enforceDraftPrivacy(input: {
  draft: unknown
  response: string
  ctx: DraftContext
  rewrite?: (feedback: string, previous: Draft) => Promise<unknown>
  allowRewrite?: boolean
}): Promise<DraftPrivacyResult> {
  let first = normalizeDraft(input.draft)
  let response = input.response
  if (!first) {
    const lifted = liftInlineDraft(input.response, input.ctx)
    if (!lifted) return { draft: null, response: input.response, outcome: 'none', flagKinds: [], rewrote: false }
    first = lifted.draft
    response = lifted.reply
  }
  const firstDraft = first
  const c1 = checkDraft(first, input.ctx)
  const flagKinds = uniq(c1.flags.map(f => f.kind))
  const done = (draft: Draft | null, outcome: DraftOutcome, rewrote: boolean): DraftPrivacyResult => ({
    draft,
    outcome,
    flagKinds,
    rewrote,
    response: !draft ? DRAFT_DECLINED_REPLY : repeatsDraft(response, [firstDraft, draft]) ? DRAFT_READY_LINE : response,
  })
  if (!needsRewrite(c1.flags)) return done(c1.cleaned, c1.flags.length ? 'signoff_fixed' : 'clean', false)

  let fallback = c1.cleaned
  let rewrote = false
  if (input.rewrite && input.allowRewrite !== false) {
    rewrote = true
    let raw: unknown = null
    try {
      raw = await input.rewrite(buildDraftFeedbackPrompt(c1.flags, effectiveAudience(first, input.ctx)), first)
    } catch (err) {
      console.error('[chat] draft rewrite failed (using the clean-up):', err instanceof Error ? err.message : err)
    }
    const second = normalizeDraft(raw)
    if (second) {
      const c2 = checkDraft(second, input.ctx)
      if (!needsRewrite(c2.flags)) return done(c2.cleaned, 'rewritten', true)
      fallback = c2.cleaned ?? fallback
    }
  }
  return fallback ? done(fallback, 'cleaned', rewrote) : done(null, 'declined', rewrote)
}
