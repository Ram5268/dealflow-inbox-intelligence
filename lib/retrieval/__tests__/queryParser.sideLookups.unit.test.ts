// Brief 43 PR 13 (Q20, Q23): the side-lookup parse finds a neighborhood only
// when one is named, and reads "under 1.6" as $1.6M. The sentences come from
// Brief 46's drift-2 probes (p2b-hoods, p2-triggers). The model fallback is a
// stand-in (lib/__tests__/fakeAiFetch.ts) that finds nothing, so these test
// the plain parse; nothing leaves this process. [engineering precaution]
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installFakeAiFetch, openAiChat } from '../../__tests__/fakeAiFetch'
import { parseQuery } from '../queryParser'

const ai = installFakeAiFetch()
ai.reply(() => openAiChat({}))

const hoods = async (q: string) => (await parseQuery(q.toLowerCase().trim())).neighborhoods

test('ordinary words are not neighborhoods', async () => {
  const msgs = [
    'make it shorter and less formal',            // "less" was the Lower East Side ("les")
    'what values do we have?',                    // "values" was the Upper East Side ("ues")
    'any sales comps?',
    'what are the rules on that?',
    'send me the files',
    'how many miles to the subway',
    'any requests from buyers?',
    'can you do tuesday instead?',
    'public records for that one',                // "public" was Long Island City ("lic")
    'is the seller confiding in anyone?',         // "fidi"
    'he lives a nomadic life',                    // "nomad"
    'is it a duplex?', 'any multifamilies?', 'thanks', 'morning drift',
    'who should I call first today?', 'draft a text to them', 'any new matches?',
  ]
  for (const m of msgs) assert.deepEqual(await hoods(m), [], m)
})

test('named neighborhoods and their short forms still count', async () => {
  const cases: Array<[string, string]> = [
    ['2br in the les', 'Lower East Side'],
    ['anything in LES?', 'Lower East Side'],
    ['ues 2br under 2m', 'Upper East Side'],
    ['uws, prewar', 'Upper West Side'],
    ['rentals in lic', 'Long Island City'],
    ['fidi condos', 'Financial District'],
    ['loft in noho', 'Noho'],
    ['soho or tribeca', 'Soho'],
    ['coming soon in bed-stuy', 'Bedford-Stuyvesant'],
    ["what's bedstuy's inventory like?", 'Bedford-Stuyvesant'],
    ['3BR in Clinton Hill under 1.6', 'Clinton Hill'],
    ['how many renters in Astoria', 'Astoria'],
  ]
  for (const [m, want] of cases) assert.ok((await hoods(m)).includes(want), `${m} → ${want}`)
})

test('"my buyer wants less than 2M" has no neighborhood', async () => {
  const p = await parseQuery('my buyer wants less than 2m')
  assert.deepEqual(p.neighborhoods, [])
  assert.equal(p.isMyBuyer, true)
})

test('"under 1.6" and "up to 1.8" in a sale ask are $1.6M and $1.8M', async () => {
  const max = async (q: string) => (await parseQuery(q.toLowerCase())).maxPrice
  const min = async (q: string) => (await parseQuery(q.toLowerCase())).minPrice
  assert.equal(await max('3BR in Clinton Hill under 1.6'), 1_600_000)
  assert.equal(await max('same thing but up to 1.8'), 1_800_000)
  assert.equal(await max('under 1.6'), 1_600_000)
  assert.equal(await max('3 family in bed-stuy under 2'), 2_000_000)
  assert.equal(await max('budget 1.25 in bushwick'), 1_250_000)
  assert.equal(await max('under 1.6 million in crown heights'), 1_600_000)
  assert.equal(await min('over 1.5, park slope'), 1_500_000)
  // Unchanged: an explicit k or M, a full number, and rents.
  assert.equal(await max('under 1.6m'), 1_600_000)
  assert.equal(await max('2br under 4k'), 4_000)
  assert.equal(await max('under $950,000'), 950_000)
  assert.equal(await max('2br rental in astoria under 3500'), 3_500)
  // A number with a unit after it is not a price in millions.
  assert.notEqual(await max('up to 5 units in bushwick'), 5_000_000)
  assert.notEqual(await min('at least 3 beds in astoria'), 3_000_000)
  assert.notEqual(await max('under 10 minutes to the subway'), 10_000_000)
})

test('an empty question never goes to the model', async () => {
  const before = ai.requests.length
  const p = await parseQuery('')
  assert.equal(ai.requests.length, before)
  assert.deepEqual(p.neighborhoods, [])
  assert.equal(p.usedLLM, false)
})

test('a very long message parses in well under a second', async () => {
  const para = 'Hi all, the sellers want less than ask; values and rules apply, public request, tuesday. '
  const long = para.repeat(600) // about 54,000 characters
  const t0 = performance.now()
  const p = await parseQuery(long.toLowerCase())
  const ms = performance.now() - t0
  assert.deepEqual(p.neighborhoods, [])
  assert.ok(ms < 1_000, `took ${ms.toFixed(0)} ms`)
})
