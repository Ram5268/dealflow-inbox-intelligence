import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SYSTEM_PROMPT } from '../systemPrompt'
import { RYAN_MD } from '../../prompts/ryanMd'

// Brief 43 PR 5: the "Your CRM sellers (D11):" lines in Drift's instructions.
// D11 [Ryan, 2026-10-18]: never list or search CRM sellers; one named seller's
// contact; opted-out sellers marked; counts fine. D13 (by address) and D15 (the
// call list), and the #10 wording [Ryan, 2026-10-19]. The D14 count line comes
// with PR 6's count tool. Pure text tests; no network, no database.
const HEADING = 'Your CRM sellers (D11):'

function block(): string {
  const start = SYSTEM_PROMPT.indexOf(HEADING)
  assert.ok(start >= 0, `SYSTEM_PROMPT has a "${HEADING}" block`)
  const end = SYSTEM_PROMPT.indexOf('\n\n', start)
  return SYSTEM_PROMPT.slice(start, end === -1 ? undefined : end)
}

test('never list or search; one named seller or address, through find_seller', () => {
  const b = block()
  assert.match(b, /Never list or search Ryan's CRM sellers/)
  assert.match(b, /names a specific seller or gives a street address, use find_seller and give that one contact/)
  assert.ok(b.includes(`say "Here's their contact."`))
  assert.match(b, /Open in CRM button, so never write a link/)
  assert.match(b, /candidates, ask which one/)
  assert.match(b, /One seller per message, and only for a name or address Ryan typed himself, never a name taken from candidates or other results\./)
})

test('do not contact: Ryan\'s wording first, and no call, text or draft, whatever other lines say', () => {
  const b = block()
  assert.ok(b.includes(`"This homeowner asked not to be contacted. Don't call or text them."`))
  assert.match(b, /offer no call, no text and no draft, even where other instructions say to give a draft/)
  // The line it overrides is still in RYAN_MD (RULE C / HARD RULES).
  assert.match(RYAN_MD, /give the draft for Ryan to copy/i)
})

test("counts in Ryan's #10 wording, the call list in the CRM Queue, and no buyers-waiting number yet", () => {
  const b = block()
  assert.ok(b.includes(`"You have [N] sellers in [area] in your CRM. Give me a name or an address and I'll pull up that one contact."`))
  assert.match(b, /use count_sellers/)
  assert.ok(b.includes(`"Your call list is in the CRM Queue, ranked fresh every morning."`))
  assert.match(b, /they're ranked in your CRM Queue/)
  assert.doesNotMatch(b, /buyers waiting[^\n]*count/i, 'the D14 count line is PR 6\'s')
  assert.ok(b.includes(`"I don't search your CRM sellers in chat. Each seller's notes are in your CRM."`))
  assert.match(b, /A phone number appears only for the one seller Ryan named/)
})

test('"your CRM", not "Mojo": the tools line, the behavior lines and RYAN_MD', () => {
  assert.ok(!/mojo/i.test(SYSTEM_PROMPT), 'no "Mojo" in SYSTEM_PROMPT')
  assert.ok(!/mojo leads/i.test(RYAN_MD), 'no "Mojo leads" in RYAN_MD')
  assert.match(SYSTEM_PROMPT, /search_parties \(buyers and renters\), find_seller \(one CRM seller Ryan names\) and count_sellers \(how many CRM sellers\)/)
  assert.match(SYSTEM_PROMPT, /Extra context \(live StreetEasy listings, your CRM seller counts, mortgage/)
  assert.ok(!SYSTEM_PROMPT.includes("seller/landlord"))
})

test('the block follows the feel standard and stays short', () => {
  const b = block()
  assert.ok(!b.includes('—'), 'no em-dash')
  assert.ok(!b.includes('!'), 'no exclamation mark')
  assert.ok(b.length < 2000, `block is ${b.length} characters`)
})
