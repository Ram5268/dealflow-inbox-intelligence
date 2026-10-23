// Brief 48 PR 13 (L4; TEST_PLAN P-04): Drift's playbook promised city-records
// lookups the code can't do: "Trigger ACRIS lookup on that address" for "who
// owned it before that?", and "call search_listings for X first to trigger the
// ACRIS fetch". The records come only from an address in Ryan's message, or
// (Brief 43 PR 11 review) the one in his previous message when he points back
// to it. The playbook now says that, and "who owned it before that?" is a
// records question, so the follow-up it describes works.
// Runs the real deed fetcher and parser on Brief 43's stand-in for the city
// datasets (lib/__tests__/fakeCityRecords.ts); nothing leaves this process.
// Addresses and names are made up.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { installFakeCityRecords } from '../../../__tests__/fakeCityRecords'
import { acrisFetcher } from '../acris'
import { RYAN_MD } from '../../../prompts/ryanMd'
import type { ParsedQuery } from '../../../retrieval/types'

const city = installFakeCityRecords()
beforeEach(() => city.reset())

const plain = (raw: string): ParsedQuery => ({
  raw, neighborhoods: [], boroughs: [], beds: null, minBeds: null, maxBeds: null, minUnits: null, maxUnits: null,
  minPrice: null, maxPrice: null, isRental: null, categories: [], intent: 'general', isCalendar: false,
  isACRIS: false, isDOB: false, isMyBuyer: false, isSellerLead: false, isEmailCampaign: false, broaden: false,
  freshnessOverrideHours: null, usedLLM: false, confidence: 0.5,
})
const followUp = (msg: string, previous: string) =>
  acrisFetcher({ parsed: plain(msg.toLowerCase()), userMessage: msg, queryText: msg.toLowerCase(), isConfirmMessage: false, previousUserMessage: previous })

test('"who owned it before that?" after a deed question looks up the same building', async () => {
  const out = await followUp('who owned it before that?', 'who owns 418 Marigold Street, Brooklyn?')
  assert.ok(city.urlsFor('8h5j-fqxa').length > 0, 'the deed lookup ran')
  assert.match(out.block ?? '', /Current owner: PAT EXAMPLE/)
  assert.match(out.block ?? '', /ADDRESS NOTE: These records are for 418 Marigold Street, Brooklyn/)
  // (The deed lookup keeps that building's records for a while, so this one
  // may not reach the city again; the block is what Drift gets.)
  const prior = await followUp('what was the prior sale on it?', 'who owns 418 Marigold Street, Brooklyn?')
  assert.match(prior.block ?? '', /ADDRESS NOTE: These records are for 418 Marigold Street, Brooklyn/, '"prior sale" too')
})

test("a follow-up that doesn't point back, or has nothing to point to, gets no records", async () => {
  assert.equal((await followUp('who owned the most buildings in 2019?', 'who owns 418 Marigold Street, Brooklyn?')).block, null)
  assert.equal((await followUp('who owned it before that?', 'any buyers in Park Slope?')).block, null)
  assert.equal(city.urlsFor('8h5j-fqxa').length, 0)
})

test("the playbook describes the lookups DealFlow actually does", () => {
  assert.doesNotMatch(RYAN_MD, /Trigger ACRIS lookup/i)
  assert.doesNotMatch(RYAN_MD, /to trigger the ACRIS fetch/i)
  assert.doesNotMatch(RYAN_MD, /auto-populates if X was in a recent tool result/i)
  assert.match(RYAN_MD, /address in Ryan's previous message/)
  assert.match(RYAN_MD, /ask Ryan for the address/i)
})
