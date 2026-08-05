import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import { register } from 'tsconfig-paths'
// tsconfig.json declares `@/*` paths but no baseUrl, so tsconfig-paths self-skips
// under ts-node. Register the alias explicitly (matchmaking.ts loads
// `@/lib/auth/orgContext` at module scope). Must run before matchmaking loads,
// hence the require below rather than a hoisted import.
register({ baseUrl: process.cwd(), paths: { '@/*': ['./*'] } })
import { prisma } from '../lib/prisma'
import { Category } from '@prisma/client'
const { scoreMatch, qualifiesAsMatch } = require('../lib/matchmaking') as typeof import('../lib/matchmaking')

// Brief 2.5, Step 4d — BEFORE/AFTER seed-match comparison ($0, read-only except
// for writing the results doc).
//
// Runs the REAL matcher scoring (imported scoreMatch + qualifiesAsMatch) over
// every valid same-side seed pair (8 buyers × 20 sale + 8 renters × 20 rental =
// 320 pairs). For each pair it reconstructs the OLD score by swapping just the
// price term (neighborhood + beds terms are held identical to NEW), so the
// comparison isolates the fractional-overlap graft. runMatchmaking() uses the
// same scoreMatch + qualifiesAsMatch, so its behavior is exactly what this
// computes — minus the DB plumbing (directional rows + mojo matches).

// Verbatim pre-graft price term, for the BEFORE column.
function oldPriceScore(listingPrice: number | null, isoMinPrice: number | null, isoMaxPrice: number | null): number {
  if (!listingPrice) return 5
  if (!isoMinPrice && !isoMaxPrice) return 5
  const min = isoMinPrice ?? 0
  const max = isoMaxPrice ?? Infinity
  if (listingPrice >= min && listingPrice <= max) return 30
  const closest = listingPrice < min ? min : max
  const pct = Math.abs(listingPrice - closest) / closest
  if (pct <= 0.15) return 20
  if (pct <= 0.25) return 10
  return 0
}

const money = (n: number | null) => (n == null ? '—' : `$${n.toLocaleString()}`)
const range = (lo: number | null, hi: number | null) => `${money(lo)}–${money(hi)}`
const name = (title: string) => title.split('—')[0].trim()
const intentOf = (reason: string) => (reason.match(/\((.+?) ->/)?.[1] ?? '?')

interface Row {
  party: string; range: string; listing: string; price: number | null
  bedsL: number | null; bedsP: number | null
  nonPrice: number; overlap: number
  oldP: number; oldScore: number; oldMatch: boolean
  newScore: number; newMatch: boolean
  intent: string; side: string
}

async function main() {
  const saleCats = [Category.COMING_SOON_SALE, Category.OFF_MARKET_SALE, Category.ACTIVE_SALE_LISTING]
  const rentCats = [Category.COMING_SOON_RENTAL, Category.RENTAL_LISTING]
  const partySel  = { id: true, extractedTitle: true, neighborhood: true, minPrice: true, maxPrice: true, beds: true }
  const listSel   = { id: true, address: true, neighborhood: true, price: true, beds: true, classificationReason: true }

  const buyers  = await prisma.extractedOpportunity.findMany({ where: { isTestData: true, category: Category.BUYER_ISO },       select: partySel, orderBy: { id: 'asc' } })
  const renters = await prisma.extractedOpportunity.findMany({ where: { isTestData: true, category: Category.RENTER_INQUIRY },  select: partySel, orderBy: { id: 'asc' } })
  const sales   = await prisma.extractedOpportunity.findMany({ where: { isTestData: true, category: { in: saleCats } },          select: listSel,  orderBy: { id: 'asc' } })
  const rentals = await prisma.extractedOpportunity.findMany({ where: { isTestData: true, category: { in: rentCats } },          select: listSel,  orderBy: { id: 'asc' } })

  const evalPair = (party: typeof buyers[number], listing: typeof sales[number], side: string): Row => {
    const res = scoreMatch(
      { neighborhood: listing.neighborhood, price: listing.price, beds: listing.beds },
      { neighborhood: party.neighborhood, minPrice: party.minPrice, maxPrice: party.maxPrice, beds: party.beds },
    )
    const newP     = Number.isNaN(res.priceOverlap) ? 5 : res.priceOverlap * 30
    const nonPrice = Math.round(res.score - newP)              // neighborhood + beds (unchanged by graft)
    const oldP     = oldPriceScore(listing.price, party.minPrice, party.maxPrice)
    const oldScore = nonPrice + oldP
    return {
      party: name(party.extractedTitle), range: range(party.minPrice, party.maxPrice),
      listing: `${listing.address} (${listing.neighborhood})`, price: listing.price,
      bedsL: listing.beds, bedsP: party.beds, nonPrice, overlap: res.priceOverlap,
      oldP, oldScore, oldMatch: oldScore >= 50,
      newScore: Math.round(res.score), newMatch: qualifiesAsMatch(res),
      intent: intentOf(listing.classificationReason), side,
    }
  }
  const rows: Row[] = []
  for (const b of buyers)  for (const s of sales)   rows.push(evalPair(b, s, 'sale'))
  for (const r of renters) for (const l of rentals) rows.push(evalPair(r, l, 'rental'))

  // Target-pair outcomes: each listing scored against its DESIGNED target party
  // (the buyer/renter it was built to test). This is the cleanest read on
  // whether the graft does what each seed row intends.
  const partyById = new Map<string, typeof buyers[number]>()
  ;[...buyers, ...renters].forEach(p => partyById.set(p.id, p))
  const targetRows: Array<{ intent: string; row: Row }> = []
  const addTarget = (listing: typeof sales[number], side: string) => {
    const t = listing.classificationReason.match(/-> (SEED_[A-Z0-9_]+)\)/)?.[1]
    const party = t ? partyById.get(t) : undefined
    if (party) targetRows.push({ intent: intentOf(listing.classificationReason), row: evalPair(party, listing, side) })
  }
  sales.forEach(s => addTarget(s, 'sale'))
  rentals.forEach(l => addTarget(l, 'rental'))
  const INTENTS = ['perfect', 'slight-over', 'slight-under', 'way-over', 'neighborhood-mismatch']
  const targetSummary = INTENTS.map(intent => {
    const rs = targetRows.filter(t => t.intent === intent).map(t => t.row)
    const wins = rs.filter(r => r.newMatch).map(r => r.newScore)
    return {
      intent, designed: rs.length,
      oldMatch: rs.filter(r => r.oldMatch).length,
      newMatch: wins.length,
      newScoreRange: wins.length ? `${Math.min(...wins)}–${Math.max(...wins)}` : '—',
    }
  })

  const oldM    = rows.filter(r => r.oldMatch)
  const newM    = rows.filter(r => r.newMatch)
  const onlyNew = rows.filter(r => r.newMatch && !r.oldMatch)
  const onlyOld = rows.filter(r => r.oldMatch && !r.newMatch)

  const ov = (r: Row) => (Number.isNaN(r.overlap) ? 'n/a' : r.overlap.toFixed(2))
  const beds = (r: Row) => `${r.bedsL ?? '—'}/${r.bedsP ?? '—'}`
  const mk = (rs: Row[]) => [
    '| Party | Party range | Listing | Price | Beds L/P | Overlap | OLD score | OLD? | NEW score | NEW? | Intent |',
    '|---|---|---|---|---|--:|--:|:-:|--:|:-:|---|',
    ...rs.map(r => `| ${r.party} | ${r.range} | ${r.listing} | ${money(r.price)} | ${beds(r)} | ${ov(r)} | ${r.oldScore} | ${r.oldMatch ? '✅' : '—'} | ${r.newScore} | ${r.newMatch ? '✅' : '—'} | ${r.intent} |`),
  ].join('\n')

  const bySideNew = (s: string) => newM.filter(r => r.side === s).length
  const md = [
    '# Seed-match results — Brief 2.5, Step 4d (BEFORE / AFTER)',
    '',
    `Scored every valid same-side seed pair: **${buyers.length} buyers × ${sales.length} sale + ${renters.length} renters × ${rentals.length} rental = ${rows.length} pairs**.`,
    'OLD = pre-graft stepped price term (0/10/20/30, no price gate). NEW = fractional `priceOverlapScore × 30` + price gate (overlap 0 with price data ⇒ disqualified). Neighborhood + beds terms are identical between OLD and NEW; only price differs.',
    '',
    '## Summary',
    '',
    '| | matches | sale | rental |',
    '|---|--:|--:|--:|',
    `| **OLD** (binary/stepped) | ${oldM.length} | ${oldM.filter(r => r.side === 'sale').length} | ${oldM.filter(r => r.side === 'rental').length} |`,
    `| **NEW** (fractional + gate) | ${newM.length} | ${bySideNew('sale')} | ${bySideNew('rental')} |`,
    `| only-NEW (near-misses surfaced) | ${onlyNew.length} | ${onlyNew.filter(r => r.side === 'sale').length} | ${onlyNew.filter(r => r.side === 'rental').length} |`,
    `| only-OLD (now price-gated out) | ${onlyOld.length} | ${onlyOld.filter(r => r.side === 'sale').length} | ${onlyOld.filter(r => r.side === 'rental').length} |`,
    '',
    '## Target-pair outcomes by intent (each listing vs its designed target buyer/renter)',
    '',
    '| Intent | designed pairs | OLD match | NEW match | NEW score range |',
    '|---|--:|--:|--:|--:|',
    ...targetSummary.map(s => `| ${s.intent} | ${s.designed} | ${s.oldMatch} | ${s.newMatch} | ${s.newScoreRange} |`),
    '',
    '## Pairs that match ONLY under NEW scoring (the "near-misses surfaced")',
    '',
    onlyNew.length ? mk(onlyNew) : '_none_',
    '',
    '## Pairs that match ONLY under OLD scoring (now correctly price-gated out)',
    '',
    onlyOld.length ? mk(onlyOld) : '_none_',
    '',
    '## All qualifying matches under NEW scoring',
    '',
    mk(newM.sort((a, b) => (a.side.localeCompare(b.side)) || (b.newScore - a.newScore))),
    '',
  ].join('\n')

  mkdirSync('docs/eval', { recursive: true })
  writeFileSync('docs/eval/seed-match-results.md', md)

  console.log(`Pairs evaluated: ${rows.length}`)
  console.log(`OLD matches: ${oldM.length}  |  NEW matches: ${newM.length}`)
  console.log(`only-NEW (surfaced): ${onlyNew.length}  |  only-OLD (gated out): ${onlyOld.length}`)
  console.log('\nTarget-pair outcomes by intent (listing vs its designed target):')
  console.table(targetSummary)
  console.log('\nonly-NEW pairs:')
  for (const r of onlyNew) console.log(`  ${r.side} | ${r.party} (${r.range}) ← ${r.listing} ${money(r.price)} | overlap ${ov(r)} | old ${r.oldScore}✗ new ${r.newScore}✓ | ${r.intent}`)
  console.log('\nonly-OLD pairs (gated out):')
  for (const r of onlyOld) console.log(`  ${r.side} | ${r.party} (${r.range}) ← ${r.listing} ${money(r.price)} | overlap ${ov(r)} | old ${r.oldScore}✓ new ${r.newScore}✗ | ${r.intent}`)
  console.log('\nWrote docs/eval/seed-match-results.md')
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
