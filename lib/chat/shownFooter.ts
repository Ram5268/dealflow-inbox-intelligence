// Brief 43 PR 8 (Q14; X-01, N13): what each Drift reply showed, kept with the
// reply so the next turn knows it. Before, the model's history held only the
// reply text, so the card ids, the buyer and the report were gone a turn later,
// and the page showed every card from every search sorted by match score, so
// Ryan's "the second one" might not be Drift's second (STAGE1_REPORT Q14).
//
// - The page shows the cards Drift named (drift_response.referencedDeals), in
//   the order it named them. A reply that named none shows every card found,
//   best match first, as before, so cards never vanish (pickShownCards).
// - The reply is stored with a compact note: those cards in that order (id,
//   address or title, price; at most FOOTER_MAX_CARDS), the buyer and report it
//   was about, and for a "+" report a 3-line summary (footerFromTurn). The note
//   sits in the stored content JSON beside a draft (lib/chat/storedReply.ts), so
//   it needs no migration.
// - The model's history gets the note after the reply text (shownNoteText). Only
//   the newest FOOTER_CARD_REPLIES replies list their cards, to keep the tokens
//   per turn down [engineering precaution].
import type { SectionResult } from '../reports/generators/types'

export const FOOTER_MAX_CARDS = 10
export const FOOTER_CARD_REPLIES = 5
const MAX_LABEL = 80
const MAX_SUMMARY_LINE = 200

export type ShownCard = { id: string; label: string; price?: string }
export type ShownFooter = {
  cards?: ShownCard[]   // in the order Ryan saw them
  more?: number         // cards shown past FOOTER_MAX_CARDS
  buyerId?: string
  reportId?: string
  summary?: string[]    // a report's summary, at most 3 lines
}

// ── Which cards the page shows ──────────────────────────────────────────────
// The cards Drift named this turn, in its order: only ids a tool returned this
// turn count (an invented or stale id is dropped), each once. None left: every
// card found, ranked by match as before.
export function pickShownCards(seenIds: readonly string[], referenced: unknown): { ids: string[]; inReplyOrder: boolean } {
  const seen = new Set(seenIds)
  const ids: string[] = []
  for (const id of Array.isArray(referenced) ? referenced : []) {
    if (typeof id === 'string' && seen.has(id) && !ids.includes(id)) ids.push(id)
  }
  return ids.length > 0 ? { ids, inReplyOrder: true } : { ids: [...seenIds], inReplyOrder: false }
}

export function orderShownDeals<T extends { id: string; matchScore: number }>(
  rows: readonly T[],
  pick: { ids: readonly string[]; inReplyOrder: boolean },
): T[] {
  if (!pick.inReplyOrder) return [...rows].sort((a, b) => b.matchScore - a.matchScore)
  const at = new Map(pick.ids.map((id, i) => [id, i]))
  return rows.filter(r => at.has(r.id)).sort((a, b) => at.get(a.id)! - at.get(b.id)!)
}

// ── The stored note ─────────────────────────────────────────────────────────
type CardRow = {
  id: string
  address?: string | null
  extractedTitle?: string | null
  price?: number | null
  minPrice?: number | null
  maxPrice?: number | null
}

// One line, no square brackets (the note's own delimiters), clipped.
function oneLine(s: unknown, max: number): string {
  if (typeof s !== 'string') return ''
  const t = s.replace(/[[\]]/g, m => (m === '[' ? '(' : ')')).replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t
}

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`

export function priceText(r: { price?: number | null; minPrice?: number | null; maxPrice?: number | null }): string | undefined {
  if (isNum(r.price)) return money(r.price)
  if (isNum(r.minPrice) && isNum(r.maxPrice)) return `${money(r.minPrice)} to ${money(r.maxPrice)}`
  if (isNum(r.maxPrice)) return `up to ${money(r.maxPrice)}`
  if (isNum(r.minPrice)) return `from ${money(r.minPrice)}`
  return undefined
}

const card = (id: string, label: string, price?: string): ShownCard => ({
  id: oneLine(id, 64), label: label || 'untitled', ...(price ? { price: oneLine(price, 40) } : {}),
})

export function footerFromTurn(turn: {
  deals?: readonly CardRow[]
  buyerId?: string | null
  reportId?: string | null
  summary?: readonly string[] | null
}): ShownFooter | null {
  const deals = turn.deals ?? []
  const cards = deals.slice(0, FOOTER_MAX_CARDS).map(d => card(d.id, oneLine(d.address, MAX_LABEL) || oneLine(d.extractedTitle, MAX_LABEL), priceText(d)))
  return footerFromParts({ cards, more: deals.length - cards.length, buyerId: turn.buyerId, reportId: turn.reportId, summary: turn.summary })
}

// A stored note read back (older rows have none; anything malformed is dropped).
export function normalizeShown(raw: unknown): ShownFooter | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const cards = (Array.isArray(r.cards) ? r.cards : [])
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string')
    .slice(0, FOOTER_MAX_CARDS)
    .map(c => card(c.id as string, oneLine(c.label, MAX_LABEL), typeof c.price === 'string' ? c.price : undefined))
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  return footerFromParts({
    cards, more: isNum(r.more) ? r.more : 0, buyerId: str(r.buyerId), reportId: str(r.reportId),
    summary: Array.isArray(r.summary) ? r.summary.filter((l): l is string => typeof l === 'string') : [],
  })
}

function footerFromParts(p: { cards: ShownCard[]; more: number; buyerId?: string | null; reportId?: string | null; summary?: readonly string[] | null }): ShownFooter | null {
  const buyerId = oneLine(p.buyerId, 64)
  const reportId = oneLine(p.reportId, 64)
  const summary = (p.summary ?? []).map(l => oneLine(l, MAX_SUMMARY_LINE)).filter(Boolean).slice(0, 3)
  const more = Math.max(0, Math.round(p.more))
  const f: ShownFooter = {
    ...(p.cards.length ? { cards: p.cards } : {}),
    ...(more ? { more } : {}),
    ...(buyerId ? { buyerId } : {}),
    ...(reportId ? { reportId } : {}),
    ...(summary.length ? { summary } : {}),
  }
  return Object.keys(f).length ? f : null
}

// ── The note in the model's history ─────────────────────────────────────────
// "[Shown with this reply: 1) 88 Example Ave, $1,850,000 (id opp_1); 2) ...;
// and 3 more. Buyer id: b_1. Report id: r_1. Report summary:\n...]". Older
// replies (withCards false) keep only the buyer, report and summary.
export const SHOWN_NOTE_PREFIX = '[Shown with this reply'

export function shownNoteText(f: ShownFooter | null, opts: { withCards: boolean }): string {
  if (!f) return ''
  const parts: string[] = []
  if (opts.withCards && f.cards?.length) {
    const list = f.cards.map((c, i) => `${i + 1}) ${c.label}${c.price ? `, ${c.price}` : ''} (id ${c.id})`).join('; ')
    parts.push(f.more ? `${list}; and ${f.more} more` : list)
  }
  if (f.buyerId) parts.push(`Buyer id: ${f.buyerId}`)
  if (f.reportId) parts.push(`Report id: ${f.reportId}`)
  if (f.summary?.length) parts.push(`Report summary:\n${f.summary.join('\n')}`)
  return parts.length ? `${SHOWN_NOTE_PREFIX}: ${parts.join('. ')}]` : ''
}

// Drift's own copy of a note (it may mimic its history) never reaches Ryan.
// Linear: a literal, then a negated class.
export const SHOWN_NOTE_ECHO = /[ \t\n]{0,4}\[Shown with this reply[^\]]*\]/g

// The buyer this turn's report or report section was for: the last report tool
// call that produced one (only those reach the guard's tool results).
export function reportBuyerId(toolResults: ReadonlyArray<{ name: string; input: unknown }>): string | null {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i]
    if (r.name !== 'generate_report' && r.name !== 'generate_report_section') continue
    const id = (r.input as { params?: { buyerId?: unknown } } | null)?.params?.buyerId
    if (typeof id === 'string' && id) return id
  }
  return null
}

// A report's summary in 3 lines: the buyer's criteria, the match counts, and how
// many items each listing section holds. Counts only past the criteria, so no
// homeowner's details ride along into Drift's history [engineering precaution].
export function reportSummaryLines(sections: readonly SectionResult[]): string[] {
  const lines: string[] = []
  const criteria = sections.find(s => s.key === 'criteria')
  const crit = criteria?.content.metrics?.find(m => m.label === 'Summary')?.value
  if (crit) lines.push(`Criteria: ${crit}`)
  const counts = sections.find(s => s.key === 'matching-inventory')?.content.metrics ?? []
  if (counts.length) lines.push(counts.map(m => `${m.label}: ${m.value}`).join(', '))
  const lists = sections.filter(s => Array.isArray(s.content.items))
  if (lists.length) lines.push(lists.map(s => `${s.title}: ${s.content.items!.length}`).join(', '))
  return lines.map(l => oneLine(l, MAX_SUMMARY_LINE))
}
