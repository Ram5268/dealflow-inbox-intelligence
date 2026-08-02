import 'dotenv/config'
import { prisma } from '../lib/prisma'

// Brief 2.5 — $0 verification of the Drift instrumentation pipeline.
//
// The real chat route (app/api/chat/route.ts) logs a DriftInteraction on every
// Sonnet turn. Exercising it end-to-end would call the LLM ($ cost), but this
// brief is capped at $0 API spend. So we prove the schema works — the table,
// the topCards JSON, and the click/feedback child tables (FK + cascade) — by
// inserting synthetic rows directly. NO LLM is called here.
//
// Real interactions populate this table organically once Ryan uses Drift.
// Rows are prefixed with SENTINEL so they're identifiable and safe to delete;
// re-running this script replaces them (idempotent).

const SENTINEL = '[VERIFY 2.5]'

const SAMPLES = [
  {
    query: `${SENTINEL} 2BR in Park Slope under 2M`,
    parsedFilters: { neighborhoods: ['Park Slope'], beds: 2, maxPrice: 2000000, transactionType: 'SALE' },
    topCards: [
      { id: 'demo_opp_a', kind: 'ACTIVE_SALE_LISTING', title: '461 6th St, 2BR – Park Slope', rank: 0, score: 0.91 },
      { id: 'demo_opp_b', kind: 'COMING_SOON_SALE',    title: '12 Garfield Pl, 2BR – Park Slope', rank: 1, score: 0.77 },
    ],
    tokensIn: 4120, tokensOut: 318, responseTimeMs: 2870,
  },
  {
    query: `${SENTINEL} renters looking in Williamsburg 4-5k`,
    parsedFilters: { neighborhoods: ['Williamsburg'], minPrice: 4000, maxPrice: 5000, transactionType: 'RENTAL' },
    topCards: [
      { id: 'demo_opp_c', kind: 'RENTAL_LISTING', title: '2BR loft – Williamsburg $4,800', rank: 0, score: 0.83 },
    ],
    tokensIn: 3980, tokensOut: 205, responseTimeMs: 2410,
  },
  {
    query: `${SENTINEL} any off market Tribeca 3BR`,
    parsedFilters: { neighborhoods: ['Tribeca'], beds: 3, transactionType: 'SALE' },
    topCards: [] as Array<{ id: string; kind: string; title: string; rank: number; score: number }>,
    tokensIn: 3650, tokensOut: 96, responseTimeMs: 1980,
  },
]

async function main() {
  // Idempotent cleanup of prior verify rows (cascades to clicks/feedback).
  const del = await prisma.driftInteraction.deleteMany({ where: { query: { startsWith: SENTINEL } } })
  if (del.count) console.log(`Cleared ${del.count} prior verify row(s).`)

  const created: string[] = []
  for (const s of SAMPLES) {
    const costUsd = (s.tokensIn / 1_000_000) * 3 + (s.tokensOut / 1_000_000) * 15
    const row = await prisma.driftInteraction.create({
      data: {
        query:          s.query,
        parsedFilters:  s.parsedFilters as unknown as object,
        topCards:       s.topCards as unknown as object[],
        responseTimeMs: s.responseTimeMs,
        modelUsed:      'claude-sonnet-4-6',
        tokensIn:       s.tokensIn,
        tokensOut:      s.tokensOut,
        costUsd,
      },
      select: { id: true },
    })
    created.push(row.id)
  }

  // Demonstrate the click + feedback children (FK + cascade) against the 1st row.
  const first = created[0]
  await prisma.driftInteractionClick.create({
    data: { interactionId: first, cardId: 'demo_opp_a', cardKind: 'ACTIVE_SALE_LISTING', rank: 0 },
  })
  await prisma.driftInteractionFeedback.create({
    data: { interactionId: first, vote: 'helpful', note: 'top card was exactly right' },
  })

  // Read them all back WITH children to prove topCards JSON round-trips.
  const rows = await prisma.driftInteraction.findMany({
    where:   { query: { startsWith: SENTINEL } },
    orderBy: { createdAt: 'asc' },
    include: { clicks: true, feedback: true },
  })

  console.log(`\nLogged ${rows.length} DriftInteraction rows (synthetic, $0 — no LLM call):\n`)
  for (const r of rows) {
    const cards = r.topCards as Array<{ title: string; rank: number; score: number }>
    console.log(`• ${r.query}`)
    console.log(`  id=${r.id}  model=${r.modelUsed}  ${r.responseTimeMs}ms  in=${r.tokensIn} out=${r.tokensOut} cost=$${r.costUsd?.toFixed(6)}`)
    console.log(`  parsedFilters=${JSON.stringify(r.parsedFilters)}`)
    console.log(`  topCards (${cards.length}): ${cards.map(c => `#${c.rank} ${c.title} [${c.score}]`).join(' | ') || '(none)'}`)
    if (r.clicks.length)   console.log(`  clicks:   ${r.clicks.map(c => `${c.cardId}@rank${c.rank}`).join(', ')}`)
    if (r.feedback.length) console.log(`  feedback: ${r.feedback.map(f => `${f.vote}${f.note ? ` — "${f.note}"` : ''}`).join(', ')}`)
    console.log()
  }
  console.log('topCards JSON round-tripped intact; click + feedback children linked via FK. No LLM called.')
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
