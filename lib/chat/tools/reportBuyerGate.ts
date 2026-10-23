// Brief 43 PR 9 (Q15; TEST_PLAN R-07, B-06; DRIFT_SCRIPT #15): no report on a
// guessed buyer. generate_report and generate_report_section run only for a
// buyer id that a search_parties call returned earlier in the same turn, so a
// report can't be saved for the wrong buyer when Drift picks a near match or
// reuses an id it remembers [engineering precaution].
//
// The route lists a tool call only once its round has finished, so a search in
// the same round as the report doesn't count: Drift hadn't seen its results.
//
// Brief 43 PR 8 x PR 9 (DRIFT_SCRIPT #16): a buyer DealFlow showed earlier in
// this chat counts too: the Buyer id or a card id in the Shown note DealFlow
// stored with an earlier reply (lib/chat/shownFooter.ts). Those ids were found
// by a tool in their own turn, and the note is written by DealFlow, never by
// Drift, so "just the near-misses for that buyer" needs no second search
// [engineering precaution].
import { readStoredShown } from '../storedReply'

// Tools whose card ids are buyers a report may be made for.
export const BUYER_ID_TOOLS: readonly string[] = ['search_parties']

// The tool error Drift reads (never shown to Ryan as is).
export const UNRESOLVED_BUYER =
  'No report made: buyerId must be the id of a buyer that search_parties returned earlier in this turn, or one in the Shown note of an earlier reply in this chat. ' +
  "Call search_parties first (query with the buyer's name, their agent's name or words from their request, plus any area, beds or budget Ryan gave), " +
  'then use the id from its results. If nothing matches exactly, tell Ryan there is no buyer by that name on file and ask which buyer he means. ' +
  'Never use the closest match.'

export function unresolvedBuyer(
  buyerId: string | null,
  toolCalls: ReadonlyArray<{ name: string; cardIds: readonly string[] }>,
  shownInChat: ReadonlySet<string> = new Set(),
): { error: string } | null {
  if (buyerId && (shownInChat.has(buyerId) || toolCalls.some(c => BUYER_ID_TOOLS.includes(c.name) && c.cardIds.includes(buyerId)))) return null
  return { error: UNRESOLVED_BUYER }
}

// The ids in the Shown notes of this chat's stored replies (the history the
// route loaded). Only Drift's stored replies carry a note; a user message never does.
export function shownIdsInChat(history: ReadonlyArray<{ role: string; content: string }>): Set<string> {
  const ids = new Set<string>()
  for (const m of history) {
    if (m.role !== 'assistant') continue
    const shown = readStoredShown(m.content)
    if (shown?.buyerId) ids.add(shown.buyerId)
    for (const c of shown?.cards ?? []) ids.add(c.id)
  }
  return ids
}
