import 'dotenv/config'
import { prisma } from '../lib/prisma'

// Brief 5.1.2 Gate 3, Step 1 — non-determinism repeat test.
// Sonnet is stochastic; a query that passes clean once might trip the guard on
// another run. Fire 5 queries 3x each (15 fires), pull parsedFilters.guard for
// each, and assert CORRECTNESS is stable across runs (guard-trigger variance is
// tolerable; wrong content leaking is not).

interface Test {
  id: string
  prompt: string
  // returns list of problems for one run.
  // recIds = SEED ids RECOMMENDED IN THE RESPONSE TEXT (the correct signal —
  // the `deals` card rail is intentionally broader, holding everything the
  // search retrieved, incl. excluded/near-miss cards and all parties surfaced).
  check: (recIds: string[], text: string, fired: boolean, canned: boolean) => string[]
}

const has = (ids: string[], id: string) => ids.includes(id)
// Above-70th UWS/UES seed listings that must NOT be recommended for "below 70th".
const ABOVE_70TH = ['SEED_SALE_08', 'SEED_SALE_12', 'SEED_SALE_15', 'SEED_SALE_18', 'SEED_RENT_05', 'SEED_RENT_11', 'SEED_RENT_14', 'SEED_RENT_17']
const listingIds = (ids: string[]) => ids.filter(i => /^SEED_(SALE|RENT)_\d+$/.test(i))

// Sonnet cites listings by id OR by address/name. Map the ids these checks care
// about to a distinctive address/name substring so detection is phrasing-robust.
// (extractedAddress is empty in seed; the address is the head of extractedTitle.)
const LABEL: Record<string, string> = {
  SEED_RENT_18: '88 greenwich',
  SEED_SALE_01: '461 6th st',
  SEED_SALE_06: '88 7th ave',
  SEED_RENT_17: '145 w 96th',
  SEED_RENTER_03: 'devon wright',
}
// True if the response text recommends this card (by id or by address/name).
const recommends = (text: string, id: string): boolean => {
  const t = text.toLowerCase()
  if (t.includes(id.toLowerCase())) return true
  const label = LABEL[id]
  return !!label && t.includes(label)
}
// Exclusion phrasing means a mentioned card was correctly ruled OUT, not recommended.
const EXCLUSION_RE = /above 70|over 70|north of 70|past 70|is out\b|ruled out|exclud|doesn'?t qualify|does not qualify|not below/i

const TESTS: Test[] = [
  {
    id: 'NDT1',
    prompt: '2BR rental below 70th st under $8500',
    check: (_recIds, text) => {
      const probs: string[] = []
      if (!recommends(text, 'SEED_RENT_18')) probs.push('response does not recommend SEED_RENT_18 (88 Greenwich)')
      // Leak: an above-70th listing recommended (not merely mentioned-and-excluded).
      const hasExclusion = EXCLUSION_RE.test(text)
      if (recommends(text, 'SEED_RENT_17') && !hasExclusion) probs.push('above-70th (145 W 96th) RECOMMENDED without exclusion')
      return probs
    },
  },
  {
    id: 'NDT2',
    prompt: 'sarah chen — got anything for her?',
    check: (recIds, text) => {
      const probs: string[] = []
      if (!recommends(text, 'SEED_SALE_01')) probs.push('response does not recommend SEED_SALE_01 (461 6th St, Park Slope)')
      // Cross-neighborhood: any recommended listing id outside the Park Slope pair.
      const allowed = new Set(['SEED_SALE_01', 'SEED_SALE_06'])
      const cross = listingIds(recIds).filter(i => !allowed.has(i))
      if (cross.length) probs.push(`cross-neighborhood listing RECOMMENDED: ${cross.join(',')}`)
      return probs
    },
  },
  {
    id: 'NDT3',
    prompt: 'what do i have at 30 Park Pl?',
    check: (recIds, _t, fired) => {
      const probs: string[] = []
      const listings = listingIds(recIds)
      if (!has(listings, 'SEED_SALE_20') || !has(listings, 'SEED_RENT_20')) probs.push(`expected both 30 Park Pl units in text, got [${listings.join(',')}]`)
      if (!fired) probs.push('guard did NOT fire (ACRIS-invention temptation should trigger)')
      return probs
    },
  },
  {
    id: 'NDT4',
    prompt: 'any renters looking in williamsburg 2BR around $5k?',
    check: (_recIds, text, fired) => {
      const probs: string[] = []
      // NDT4 is a party (renter) query — Devon Wright / SEED_RENTER_03.
      if (!recommends(text, 'SEED_RENTER_03')) probs.push('response does not reference SEED_RENTER_03 (Devon Wright)')
      if (!fired) probs.push('guard did NOT fire (StreetEasy-URL temptation should trigger)')
      return probs
    },
  },
  {
    id: 'NDT5',
    prompt: 'prewar buildings in chelsea',
    check: (_recIds, _t, _fired, canned) => {
      const probs: string[] = []
      // Key criterion: NO canned fallback (that would be a Brief 5.1.1 regression).
      if (canned) probs.push('FELL BACK TO CANNED (Brief 5.1.1 false-positive regression)')
      return probs
    },
  },
]

// Extract SEED ids mentioned in the response text (what Sonnet actually cites).
const idsInText = (text: string): string[] => [...new Set((text.match(/SEED_[A-Z]+_\d+/g) ?? []))]

const CHAT_URL = process.env.CHAT_URL ?? 'http://localhost:3002/api/chat'
const RUNS = 3

async function fire(prompt: string): Promise<{ interactionId: string; response: string; error?: string }> {
  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: prompt }),
    })
    const data = await res.json() as any
    return { interactionId: data.interactionId, response: data.response ?? '' }
  } catch (e) { return { interactionId: '', response: '', error: String(e) } }
}

async function main() {
  console.log(`Gate 3 Step 1 — non-determinism: ${TESTS.length} queries × ${RUNS} runs\n`)
  const fires: Array<{ id: string; run: number; interactionId: string; response: string; error?: string }> = []
  for (const t of TESTS) {
    for (let run = 1; run <= RUNS; run++) {
      process.stdout.write(`  ${t.id} run ${run} … `)
      const r = await fire(t.prompt)
      console.log(r.error ? `ERROR ${r.error}` : `ok ${r.interactionId?.slice(-6)}`)
      fires.push({ id: t.id, run, interactionId: r.interactionId, response: r.response, error: r.error })
      await new Promise(res => setTimeout(res, 400))
    }
  }

  const ids = fires.map(f => f.interactionId).filter(Boolean)
  const rows = await prisma.driftInteraction.findMany({
    where: { id: { in: ids } },
    select: { id: true, parsedFilters: true, topCards: true, costUsd: true },
  })
  const rowById = new Map(rows.map(r => [r.id, r]))

  let totalCost = 0
  const summary: Array<{ id: string; runs: Array<{ recIds: string[]; cards: string[]; fired: boolean; canned: boolean; text: string; probs: string[] }> }> = []

  for (const t of TESTS) {
    const runsData = fires.filter(f => f.id === t.id).map(f => {
      const row = rowById.get(f.interactionId)
      const g = (row?.parsedFilters as any)?.guard
      const cards = ((row?.topCards as any[]) ?? []).map(c => c?.id).filter(Boolean)
      const recIds = idsInText(f.response)
      const fired = !!g && (g.finalAttempt > 0 || g.fellbackToCanned)
      const canned = !!g?.fellbackToCanned
      totalCost += row?.costUsd ?? 0
      return { recIds, cards, fired, canned, text: f.response, probs: t.check(recIds, f.response, fired, canned) }
    })
    summary.push({ id: t.id, runs: runsData })
  }

  console.log('\n' + '═'.repeat(80))
  console.log('STEP 1 RESULTS (correctness judged on RESPONSE-TEXT recommendations)')
  console.log('═'.repeat(80))
  let allPass = true
  for (const s of summary) {
    const firedCount = s.runs.filter(r => r.fired).length
    const cannedCount = s.runs.filter(r => r.canned).length
    const anyProb = s.runs.some(r => r.probs.length)
    if (anyProb) allPass = false
    console.log(`\n${s.id}  fired ${firedCount}/${RUNS}  canned ${cannedCount}/${RUNS}  ${anyProb ? '❌' : '✅'}`)
    s.runs.forEach((r, i) => {
      console.log(`  run ${i + 1}: recommends=[${r.recIds.join(', ')}] fired=${r.fired} canned=${r.canned}${r.probs.length ? '  PROBLEMS: ' + r.probs.join('; ') : ''}`)
    })
  }
  console.log('\n' + '─'.repeat(80))
  console.log(`Total spend: $${totalCost.toFixed(4)}`)
  console.log(allPass ? '✅ STEP 1 PASS — correctness stable across all runs' : '❌ STEP 1 has correctness variance — see PROBLEMS above')
  await prisma.$disconnect()
  process.exit(allPass ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
