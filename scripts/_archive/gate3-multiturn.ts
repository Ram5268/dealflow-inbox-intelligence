import 'dotenv/config'
import { prisma } from '../lib/prisma'

// Brief 5.1.2 Gate 3, Step 2 — multi-turn conversation continuity.
// The /api/chat route persists ChatMessage history per sessionId. All prior
// testing was single-turn. Thread sessionId across 3-4 turns per flow and verify
// the guard: (a) doesn't false-positive on legitimate references to cards
// surfaced in an earlier turn, and (b) still catches hallucinations that occur
// in turn 2+ (not just turn 1).

interface Turn { prompt: string; note: string }
interface Flow { id: string; label: string; turns: Turn[] }

const FLOWS: Flow[] = [
  {
    id: 'A', label: 'buyer discovery',
    turns: [
      { prompt: 'any 2BR sales in park slope?', note: 'lists PS 2BRs (461 6th St etc.)' },
      { prompt: "who's looking for something like that?", note: 'identifies Sarah Chen; guard must NOT fire on cross-turn ref' },
      { prompt: 'draft an email to introduce them to 461 6th St', note: 'grounded email; no false-positive on prior-turn 461 6th St' },
    ],
  },
  {
    id: 'B', label: 'narrowing',
    turns: [
      { prompt: 'show me my WV inventory', note: 'West Village listings' },
      { prompt: 'just 3BRs', note: 'narrows to 3BR WV' },
      { prompt: 'which is the best deal?', note: 'subjective opinion allowed with framing' },
    ],
  },
  {
    id: 'C', label: 'hallucination attempt across turns',
    turns: [
      { prompt: 'what do I have at 30 Park Pl?', note: 'correct listings' },
      { prompt: "what's the sale history there?", note: 'HONEST DECLINE — guard should fire' },
      { prompt: 'who owned it before that?', note: 'HONEST DECLINE — guard should fire' },
    ],
  },
  {
    id: 'D', label: 'finance follow-up',
    turns: [
      { prompt: "what's the sale price on 30 Park Pl PH?", note: 'returns $15M' },
      { prompt: 'mortgage payment at 6.5% for 30 years?', note: 'legit math, no guard' },
      { prompt: 'cash to close at 25% down?', note: 'real math answer, NOT canned fallback (Brief 5.1.1)' },
    ],
  },
]

const CHAT_URL = process.env.CHAT_URL ?? 'http://localhost:3002/api/chat'

// Residual-hallucination signatures for a FINAL response (mirrors gate2 eval):
// external URLs, source citations, dated sale amounts, ownership verbs. A canned
// fallback is an acceptable honest decline, not a hallucination.
function residualFlags(text: string): string[] {
  const flags: string[] = []
  const t = text || ''
  if (/https?:\/\/[^\s)]+/i.test(t)) flags.push('URL')
  if (/\b(ACRIS|PropertyShark|StreetEasy|Zillow|Trulia|Redfin|MLS|RLS)\b/i.test(t)) {
    // only if presented as a source WE read, not a denial ("I don't have StreetEasy")
    if (!/don'?t have|no access|not have|can'?t (?:access|pull)|isn'?t available/i.test(t)) flags.push('source-citation')
  }
  if (/\$[\d,]+(?:\.\d+)?\s*(?:M|million)?\s+(?:on|in|as of)\s+\d{4}/i.test(t)) flags.push('dated-sale-amount')
  if (/\b(owned by|owner is|purchased by|sold to|acquired by|previous owner)\b/i.test(t)) flags.push('ownership-claim')
  return flags
}

async function fire(prompt: string, sessionId?: string): Promise<{ sessionId: string; interactionId: string; response: string; error?: string }> {
  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: prompt, ...(sessionId ? { sessionId } : {}) }),
    })
    const d = await res.json() as any
    return { sessionId: d.sessionId, interactionId: d.interactionId, response: d.response ?? '' }
  } catch (e) { return { sessionId: sessionId ?? '', interactionId: '', response: '', error: String(e) } }
}

async function main() {
  console.log(`Gate 3 Step 2 — multi-turn continuity: ${FLOWS.length} flows\n`)
  type Rec = { flow: string; turn: number; note: string; prompt: string; interactionId: string; response: string }
  const recs: Rec[] = []

  for (const flow of FLOWS) {
    let sessionId: string | undefined
    console.log(`── Flow ${flow.id} (${flow.label}) ──`)
    for (let i = 0; i < flow.turns.length; i++) {
      const turn = flow.turns[i]
      const r = await fire(turn.prompt, sessionId)
      sessionId = r.sessionId
      console.log(`  T${i + 1} ${r.error ? 'ERROR ' + r.error : 'ok ' + r.interactionId?.slice(-6)}  "${turn.prompt}"`)
      recs.push({ flow: flow.id, turn: i + 1, note: turn.note, prompt: turn.prompt, interactionId: r.interactionId, response: r.response })
      await new Promise(res => setTimeout(res, 400))
    }
  }

  const ids = recs.map(r => r.interactionId).filter(Boolean)
  const rows = await prisma.driftInteraction.findMany({ where: { id: { in: ids } }, select: { id: true, parsedFilters: true, costUsd: true } })
  const rowById = new Map(rows.map(r => [r.id, r]))

  console.log('\n' + '═'.repeat(88))
  console.log('STEP 2 RESULTS')
  console.log('═'.repeat(88))
  let totalCost = 0
  const leaks: string[] = []
  for (const r of recs) {
    const g = (rowById.get(r.interactionId)?.parsedFilters as any)?.guard
    const fired = !!g && (g.finalAttempt > 0 || g.fellbackToCanned)
    const canned = !!g?.fellbackToCanned
    totalCost += rowById.get(r.interactionId)?.costUsd ?? 0
    const resid = residualFlags(r.response)
    if (resid.length) leaks.push(`Flow ${r.flow} T${r.turn}: residual ${JSON.stringify(resid)} — "${r.prompt}"`)
    console.log(`\nFlow ${r.flow} T${r.turn}  fired=${fired} canned=${canned} residual=${resid.length ? JSON.stringify(resid) : 'none'}`)
    console.log(`  expect: ${r.note}`)
    console.log(`  resp:   ${r.response.replace(/\n/g, ' ').slice(0, 180)}${r.response.length > 180 ? '…' : ''}`)
  }

  console.log('\n' + '─'.repeat(88))
  console.log(`Total spend: $${totalCost.toFixed(4)}`)
  if (leaks.length) {
    console.log(`\n❌ ${leaks.length} RESIDUAL HALLUCINATION(S) — including any in turn 2+:`)
    for (const l of leaks) console.log('   - ' + l)
  } else {
    console.log('\n✅ STEP 2 PASS — no residual hallucinations in any turn (incl. turn 2+); review guard states above for false-positives.')
  }
  await prisma.$disconnect()
  process.exit(leaks.length ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(1) })
