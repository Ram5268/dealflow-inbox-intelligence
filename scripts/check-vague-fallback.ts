import { parseQuery } from '../lib/retrieval/queryParser'
import { isVague } from '../lib/retrieval'

interface Case {
  q: string
  vague: boolean
  why: string
}

const cases: Case[] = [
  { q: 'what do I have?',                       vague: true,  why: 'no signal' },
  { q: 'anything new',                          vague: true,  why: 'no signal' },
  { q: 'show me everything',                    vague: true,  why: 'no signal' },
  { q: 'rentals in Williamsburg',               vague: false, why: 'neighborhood + isRental' },
  { q: 'my buyer in Brooklyn',                  vague: false, why: 'isMyBuyer + borough' },
  { q: 'who owns 123 Main St?',                 vague: false, why: 'isACRIS' },
  { q: '2BR under $3000',                       vague: false, why: 'beds + price' },
  { q: 'seller leads in Bushwick',              vague: false, why: 'isSellerLead + neighborhood' },
]

async function main() {
  let pass = 0
  let fail = 0
  for (const c of cases) {
    const parsed = await parseQuery(c.q)
    const got    = isVague(parsed)
    const ok     = got === c.vague
    console.log(`${ok ? 'PASS' : 'FAIL'}  isVague=${String(got).padEnd(5)} "${c.q}"  (${c.why})`)
    if (!ok) {
      console.log(`  expected ${c.vague}, got ${got}`)
      console.log(`  parsed:`, JSON.stringify({
        neighborhoods: parsed.neighborhoods, boroughs: parsed.boroughs,
        beds: parsed.beds, minBeds: parsed.minBeds, maxBeds: parsed.maxBeds,
        minPrice: parsed.minPrice, maxPrice: parsed.maxPrice,
        isRental: parsed.isRental, categories: parsed.categories,
        isCalendar: parsed.isCalendar, isACRIS: parsed.isACRIS, isDOB: parsed.isDOB,
        isMyBuyer: parsed.isMyBuyer, isSellerLead: parsed.isSellerLead, isEmailCampaign: parsed.isEmailCampaign,
      }, null, 2))
    }
    ok ? pass++ : fail++
  }
  console.log(`\n${pass}/${pass + fail} passed`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('Script error:', err)
  process.exit(1)
})
