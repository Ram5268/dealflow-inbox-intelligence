// Phase 4.1 smoke — run the tiered waterfall on 10 representative URLs.
// Reports {url, host, expected tier, actual tier, chars, ms, pass/fail}.
import 'dotenv/config'
import { scrapeUrl } from '../lib/scraping/scrapeUrl'

interface Case { url: string; label: string; expect: '1/2' | '3' | 'null' }

const CASES: Case[] = [
  { url: 'https://therealdeal.com/new-york/',           label: 'TheRealDeal (RE news)',      expect: '1/2' },
  { url: 'https://www.brownstoner.com/',                label: 'Brownstoner (broker blog)',  expect: '1/2' },
  { url: 'https://www.compass.com/',                    label: 'Compass (homepage)',         expect: '1/2' },
  { url: 'https://www.compass.com/for-sale/new-york-ny/', label: 'Compass (listings search)', expect: '1/2' },
  { url: 'https://www.elliman.com/',                    label: 'Elliman (homepage)',         expect: '1/2' },
  { url: 'https://www.elliman.com/newyorkcity',         label: 'Elliman (NYC section)',      expect: '1/2' },
  { url: 'https://www.corcoran.com/',                   label: 'Corcoran (homepage)',        expect: '1/2' },
  { url: 'https://www.sothebysrealty.com/',             label: 'Sothebys (brokerage home)',  expect: '1/2' },
  { url: 'https://streeteasy.com/for-sale/nyc',         label: 'StreetEasy (PerimeterX→T3)', expect: '3'   },
  { url: 'https://t.apemail.net/q/this-is-a-dead-tracking-link-xyz', label: 'tracking link (should fail)', expect: 'null' },
]

async function main() {
  console.log('Phase 4.1 scraper smoke — 10 URLs\n')
  const rows: { label: string; host: string; expect: string; tier: string; chars: number; ms: number; pass: boolean }[] = []
  for (const c of CASES) {
    const host = (() => { try { return new URL(c.url).hostname } catch { return '?' } })()
    const t0 = Date.now()
    let res = null
    try { res = await scrapeUrl(c.url) } catch (e) { console.error(`  threw on ${c.url}: ${(e as Error).message}`) }
    const ms = Date.now() - t0
    const tier = res ? String(res.tier) : 'null'
    const chars = res?.markdown.length ?? 0
    const pass =
      c.expect === 'null' ? res === null :
      c.expect === '3'    ? (res?.tier === 3) :
      /* 1/2 */             (res?.tier === 1 || res?.tier === 2)
    rows.push({ label: c.label, host, expect: c.expect, tier, chars, ms, pass })
    console.log(`  ${pass ? '✓' : '✗'} [${c.label}] host=${host} expect=${c.expect} tier=${tier} chars=${chars} ms=${ms}`)
  }

  console.log('\n| URL | Host | Expect | Tier | Chars | ms | Pass |')
  console.log('|---|---|---|---|---|---|---|')
  for (const r of rows) console.log(`| ${r.label} | ${r.host} | ${r.expect} | ${r.tier} | ${r.chars} | ${r.ms} | ${r.pass ? 'PASS' : 'FAIL'} |`)

  const content = rows.filter(r => r.expect === '1/2')
  const contentPass = content.filter(r => r.pass).length
  const slow = rows.filter(r => r.ms > 30_000)
  console.log(`\nContent URLs (T1/T2) passing: ${contentPass}/${content.length}`)
  console.log(`StreetEasy via Tier 3: ${rows.find(r => r.expect === '3')?.pass ? 'PASS' : 'FAIL'}`)
  console.log(`Tracking link returns null: ${rows.find(r => r.expect === 'null')?.pass ? 'PASS' : 'FAIL'}`)
  console.log(`Any call > 30s: ${slow.length ? 'YES — ' + slow.map(s => s.label).join(', ') : 'no'}`)
}

main().catch(e => { console.error(e); process.exit(1) })
