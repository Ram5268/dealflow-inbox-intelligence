import { parseQuery } from '../lib/retrieval/queryParser'

interface Case {
  q: string
  exp: { isMyBuyer: boolean; isSellerLead: boolean; isEmailCampaign: boolean }
}

const cases: Case[] = [
  { q: 'my buyer in Williamsburg',           exp: { isMyBuyer: true,  isSellerLead: false, isEmailCampaign: false } },
  { q: 'buyers in Bed-Stuy',                 exp: { isMyBuyer: false, isSellerLead: false, isEmailCampaign: false } },
  { q: 'seller leads in Bushwick',           exp: { isMyBuyer: false, isSellerLead: true,  isEmailCampaign: false } },
  { q: 'email campaign replies',             exp: { isMyBuyer: false, isSellerLead: false, isEmailCampaign: true  } },
  { q: 'for my client looking under 2M',     exp: { isMyBuyer: true,  isSellerLead: false, isEmailCampaign: false } },
]

async function main() {
  let pass = 0
  let fail = 0
  for (const c of cases) {
    const p = await parseQuery(c.q)
    const got = {
      isMyBuyer:       p.isMyBuyer,
      isSellerLead:    p.isSellerLead,
      isEmailCampaign: p.isEmailCampaign,
    }
    const ok = JSON.stringify(got) === JSON.stringify(c.exp)
    console.log(`${ok ? 'PASS' : 'FAIL'}  "${c.q}"`)
    if (!ok) {
      console.log(`  expected ${JSON.stringify(c.exp)}`)
      console.log(`  got      ${JSON.stringify(got)}`)
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
