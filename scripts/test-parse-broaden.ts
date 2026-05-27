// Unit tests for Phase D.5: parsed.broaden detection in lib/retrieval/queryParser.ts
// Project has no Jest/Vitest. Runs assertions inline, exits 1 on failure.
//   npx tsx scripts/test-parse-broaden.ts

import { parseQuery } from '../lib/retrieval/queryParser'

let failures = 0
const cases: Array<{ q: string; expected: boolean; note: string }> = [
  { q: 'in bedstuy',                                        expected: false, note: 'plain "in X" — strict' },
  { q: 'in bedstuy or nearby',                              expected: true,  note: '"or nearby" → broaden' },
  { q: 'near bedstuy',                                      expected: true,  note: '"near X" → broaden' },
  { q: 'around fidi',                                       expected: true,  note: '"around X" → broaden' },
  { q: 'bedstuy or similar areas',                          expected: true,  note: '"or similar" → broaden' },
  { q: 'Bed-Stuy or Clinton Hill',                          expected: false, note: 'multi-neighborhood, not broaden' },
  { q: 'anywhere in Brooklyn',                              expected: false, note: 'borough-level — not broaden' },
  // Bonus coverage
  { q: '2BR rentals close to bedstuy under 4k',             expected: true,  note: '"close to" → broaden' },
  { q: 'show me listings in or around the LES',             expected: true,  note: '"in or around" → broaden' },
  { q: 'buyer for 1BR in fidi and similar areas',           expected: true,  note: '"and similar" → broaden' },
  { q: 'what do I have in Tribeca',                         expected: false, note: 'plain "in X" — strict' },
  { q: 'rentals in Williamsburg or surrounding neighborhoods', expected: true, note: '"or surrounding" → broaden' },
]

async function main() {
  for (const { q, expected, note } of cases) {
    const p = await parseQuery(q)
    const got = p.broaden
    const ok  = got === expected
    if (ok) {
      console.log(`  ✅ broaden=${got} — "${q}"  (${note})`)
    } else {
      console.log(`  ❌ broaden=${got} but expected ${expected} — "${q}"  (${note})`)
      failures++
    }
  }

  console.log()
  if (failures > 0) {
    console.log(`❌ ${failures} test(s) failed`)
    process.exit(1)
  }
  console.log('✅ All broaden-detection tests passed')
}
main().catch(e => { console.error(e); process.exit(1) })
