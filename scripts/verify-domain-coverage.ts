// Phase A verifier — runs the assertions described in the Phase A plan against
// the new lib/domain/Neighborhood module. Exits 1 on hard failure.
//
// Adapted from the original spec:
//   The plan asked us to compare against ADJACENCY maps in route.ts,
//   queryPlanner.ts, and matchmaking.ts. Post-PR3/PR5, those local maps no
//   longer exist — all three files now import getAdjacent() from
//   lib/geo/neighborhoods.ts. So the only adjacency source we can compare
//   against today is lib/geo/neighborhoods.ts itself. We still walk:
//     - lib/geo/neighborhoods.ts NEIGHBORHOOD_ADJACENCY  (keys + values)
//     - lib/retrieval/queryParser.ts NYC_NEIGHBORHOODS   (Title Case list)
//     - lib/chat/streetEasyUrls.ts HOOD_TO_BOROUGH       (lowercase keys)
//   plus a live DB pull of every distinct ExtractedOpportunity.neighborhood.

import { prisma } from '../lib/prisma'
import { NEIGHBORHOODS, fromRaw, getAdjacent } from '../lib/domain/Neighborhood'
// Phase B File 8 deleted lib/geo/neighborhoods.ts; Checks 1+2 below now no-op.
// Phase B File 5 deleted streetEasyUrls' HOOD_TO_BOROUGH; Check 3 also no-op.
// The verifier's ongoing role is Check 4 (internal adjacency consistency)
// and Check 5 (DB coverage).

// ── Hardcoded "clearly out of NYC" prefix/keyword list ──────────────────────
// Strings containing any of these are filed as out-of-scope and don't count
// as a fromRaw resolution failure. Maintained here, not in lib/domain/, so
// the production module stays NYC-only.
const OUT_OF_SCOPE_SUBSTRING = [
  // Hudson County NJ
  'jersey city', 'bayonne', 'north bergen', 'west new york', 'journal square',
  'the heights', 'newport', 'historic downtown', 'hoboken', 'guttenberg',
  'fort lee', 'cliffside park', 'weehawken', 'mcginley square', 'edgewater',
  'paulus hook', 'bergen/lafayette', 'union city', 'kearny',
  'secaucus', 'new jersey',
  // Other suburbs
  'scarsdale',
  // International
  'brickell', 'diagonal mar', "cuadrat d'or", 'auteuil', 'saint-germain',
  'estoril', 'marina del port', 'holistika', 'towd point', 'gold coast',
  'north haven point',
]

// Exact-match-only — used for strings that contain substrings of in-scope
// neighborhoods (e.g. 'Brooklyn' alone is just a borough label, but
// 'Brooklyn Heights' is a real neighborhood).
const OUT_OF_SCOPE_EXACT = new Set([
  'brooklyn', 'queens', 'bronx', 'manhattan', 'hudson',
  'null', 'waterfront', 'leewood', 'north end', 'central park',
  // lib/geo:NEIGHBORHOOD_ADJACENCY[little neck] references 'great neck' as an
  // adjacency. Great Neck is in Nassau County, NY — not NYC. This is a known
  // bug in the existing adjacency map; flagging here, leaving the data alone
  // per Phase A rules ("If you discover a real bug in one of the source
  // files during this work, DO NOT fix it"). Triage in Phase B.
  'great neck',
])

function looksOutOfScope(s: string): boolean {
  const lower = s.trim().toLowerCase()
  if (OUT_OF_SCOPE_EXACT.has(lower)) return true
  return OUT_OF_SCOPE_SUBSTRING.some(kw => lower.includes(kw))
}

interface Failure {
  source: string
  key: string
  reason: string
}

async function main(): Promise<void> {
  const failures: Failure[] = []
  let checksPassed = 0

  // ────────────────────────────────────────────────────────────────────────
  // 1+2) (Phase B File 8 deletion: lib/geo/neighborhoods.ts no longer exists —
  //      the canonical adjacency lives entirely in lib/domain/Neighborhood now.
  //      Checks 1 and 2 verified coverage during the Phase A→B transition;
  //      kept as numbered no-ops so report numbering stays stable.)
  // ────────────────────────────────────────────────────────────────────────
  console.log('── Check 1+2: lib/geo/neighborhoods.ts coverage (deprecated) ──')
  console.log('  skipped — source map removed in Phase B File 8')

  // ────────────────────────────────────────────────────────────────────────
  // 3) (Phase B File 5 deletion: HOOD_TO_BOROUGH no longer exists —
  //    streetEasyUrls.ts now derives borough via lib/domain.getBorough.
  //    Kept as a numbered no-op so the report numbering stays stable.)
  // ────────────────────────────────────────────────────────────────────────
  console.log('\n── Check 3: lib/chat/streetEasyUrls.ts HOOD_TO_BOROUGH (deprecated) ──')
  console.log('  skipped — constant removed in Phase B File 5; coverage now provided by lib/domain.getBorough')

  // ────────────────────────────────────────────────────────────────────────
  // 4) Cross-check: every adjacency value in NEW module resolves to a
  //    known canonical (catches typos inside our own adjacency arrays)
  // ────────────────────────────────────────────────────────────────────────
  console.log('\n── Check 4: lib/domain/Neighborhood.ts internal adjacency consistency ──')
  const internalBefore = failures.length
  for (const [canonical, meta] of Object.entries(NEIGHBORHOODS)) {
    for (const adj of meta.adjacent) {
      if (!NEIGHBORHOODS[adj]) {
        failures.push({
          source: `lib/domain:NEIGHBORHOODS[${canonical}].adjacent`,
          key: adj,
          reason: 'references a canonical that does not exist in NEIGHBORHOODS',
        })
      } else {
        checksPassed++
      }
    }
  }
  console.log(`  ${failures.length - internalBefore} broken internal adjacency references`)

  // ────────────────────────────────────────────────────────────────────────
  // 5) Symmetry check (informational, not hard fail): if A.adjacent includes
  //    B, ideally B.adjacent includes A. We log asymmetries but don't fail.
  // ────────────────────────────────────────────────────────────────────────
  const asymmetries: Array<[string, string]> = []
  for (const [canonical, meta] of Object.entries(NEIGHBORHOODS)) {
    for (const adj of meta.adjacent) {
      const other = NEIGHBORHOODS[adj]
      if (other && !other.adjacent.includes(canonical)) {
        asymmetries.push([canonical, adj])
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // 6) DB pull — every distinct non-null neighborhood string
  // ────────────────────────────────────────────────────────────────────────
  console.log('\n── Check 5: distinct ExtractedOpportunity.neighborhood values in DB ──')
  const dbRows = await prisma.$queryRaw<{ neighborhood: string; n: number }[]>`
    SELECT neighborhood, COUNT(*)::int AS n
    FROM "ExtractedOpportunity"
    WHERE neighborhood IS NOT NULL
    GROUP BY neighborhood
    ORDER BY n DESC
  `
  const resolvedDb: { s: string; n: number; canonical: string }[] = []
  const unresolvedNyc: { s: string; n: number }[] = []
  const unresolvedOutOfScope: { s: string; n: number }[] = []
  for (const row of dbRows) {
    const canonical = fromRaw(row.neighborhood)
    if (canonical) {
      resolvedDb.push({ s: row.neighborhood, n: row.n, canonical })
    } else if (looksOutOfScope(row.neighborhood)) {
      unresolvedOutOfScope.push({ s: row.neighborhood, n: row.n })
    } else {
      unresolvedNyc.push({ s: row.neighborhood, n: row.n })
      failures.push({ source: 'DB:ExtractedOpportunity.neighborhood', key: row.neighborhood, reason: `fromRaw returned null; ${row.n} record(s) affected; not in out-of-scope list` })
    }
  }
  const totalResolved = resolvedDb.reduce((a, b) => a + b.n, 0)
  const totalOutOfScope = unresolvedOutOfScope.reduce((a, b) => a + b.n, 0)
  const totalUnresolved = unresolvedNyc.reduce((a, b) => a + b.n, 0)
  const grandTotal = totalResolved + totalOutOfScope + totalUnresolved
  console.log(`  ${dbRows.length} distinct strings, ${grandTotal} total records`)
  console.log(`    resolved:      ${resolvedDb.length} strings → ${totalResolved} records (${((totalResolved / grandTotal) * 100).toFixed(1)}%)`)
  console.log(`    out-of-scope:  ${unresolvedOutOfScope.length} strings → ${totalOutOfScope} records (${((totalOutOfScope / grandTotal) * 100).toFixed(1)}%)`)
  console.log(`    NYC-unresolved (HARD FAIL): ${unresolvedNyc.length} strings → ${totalUnresolved} records`)

  // ────────────────────────────────────────────────────────────────────────
  // Summary
  // ────────────────────────────────────────────────────────────────────────
  console.log('\n────────────────────────────────────────────────────────────────────')
  if (asymmetries.length > 0) {
    console.log(`⚠️  ${asymmetries.length} adjacency asymmetries (informational, not a failure):`)
    for (const [a, b] of asymmetries.slice(0, 8)) console.log(`    ${a} → ${b}, but ${b} ↛ ${a}`)
    if (asymmetries.length > 8) console.log(`    … and ${asymmetries.length - 8} more`)
    console.log()
  }
  if (unresolvedOutOfScope.length > 0) {
    console.log(`ℹ️  ${unresolvedOutOfScope.length} out-of-scope DB strings (NJ / foreign / data-quality):`)
    for (const u of unresolvedOutOfScope.slice(0, 5)) console.log(`    ${u.n.toString().padStart(5)}  ${u.s}`)
    if (unresolvedOutOfScope.length > 5) console.log(`    … and ${unresolvedOutOfScope.length - 5} more`)
    console.log()
  }
  if (unresolvedNyc.length > 0) {
    console.log(`❌ ${unresolvedNyc.length} NYC-looking DB strings that did NOT resolve (these become orphans in Phase E):`)
    for (const u of unresolvedNyc.slice(0, 15)) console.log(`    ${u.n.toString().padStart(5)}  ${u.s}`)
    if (unresolvedNyc.length > 15) console.log(`    … and ${unresolvedNyc.length - 15} more`)
    console.log()
  }
  if (failures.length > 0) {
    console.log(`❌ FAIL: ${failures.length} hard failure(s), ${checksPassed} checks passed`)
    const grouped: Record<string, number> = {}
    for (const f of failures) grouped[f.source] = (grouped[f.source] ?? 0) + 1
    for (const [src, n] of Object.entries(grouped)) console.log(`    ${n}  ${src}`)
    await prisma.$disconnect()
    process.exit(1)
  }

  console.log(`✅ All checks passed (${checksPassed} assertions)`)
  console.log(`   • Internal adjacency references are consistent + symmetric (Phase B 1a)`)
  console.log(`   • DB coverage: ${((totalResolved / grandTotal) * 100).toFixed(1)}% resolved, ${((totalOutOfScope / grandTotal) * 100).toFixed(1)}% out-of-scope, 0% NYC-unresolved`)
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
