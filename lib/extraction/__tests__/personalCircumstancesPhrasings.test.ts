// Brief 41.1 (review F4) — the personal-circumstances filter on the phrasings
// the Brief 41 review probe (filter-probe.ts) found it missing or wrongly
// catching, plus how it splits text. Pure: imports only the filter.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mentionsPersonalCircumstances as mentions, withoutPersonalCircumstances as without, sellerSummary } from '../personalCircumstances'

// Ordinary real-estate text that must be kept, including some with sensitive
// words in them ("Owner passed on our first offer", "separating the lots").
const SHOULD_KEEP = [
  'Real estate investor wants to sell', 'REAL ESTATE OWNED', 'realestate group', 'The state requires a disclosure.',
  'Estate-style detached home with driveway', 'Kensington Estates co-op unit', 'Bayside Estates two-family',
  'Buyer will inherit two rent-stabilized tenants.', 'You inherit the existing lease.', 'Owner is dead set on selling by June.',
  'Drop-dead skyline views from the roof.', 'drop dead gorgeous townhouse', 'The listing died on the market last year.',
  'The deal is dead.', 'dead space under the stairs', 'Corner lot on a dead-end street', "Widow's walk on the roof.",
  'Across from a nursing home.', 'Former funeral home, zoned R6.', 'They are separated by a courtyard.',
  'executive suite', 'Illinois buyer', 'ill-advised renovation', 'state of the art kitchen', 'estate agent valuation',
  'Owner passed on our first offer.', 'the owner passed the co-op board', 'the owner passed inspection',
  'Owner is separating the lots.', 'heirloom fixtures', 'Estates at Brooklyn Heights', 'Probably selling in spring',
]

// Personal circumstances that must be caught.
const SHOULD_CATCH = [
  'The owner passed two months ago.', 'the owner passed this spring and the kids want to sell',
  'The seller passed in March.', 'The homeowner passed last year.', 'After she passed, the family decided to sell.',
  'Since he passed the house has been empty', 'Her mother is sick.', 'Owner is very sick', 'in poor health',
  'failing health', 'The couple is splitting up.', 'The Smiths are separating.', "They're separating.", "we're getting separated",
  'his ex wife', 'her ex', 'estranged son', 'died intestate', "the decedent's house", 'the late Mr. Smith',
  'after the passing of her mother', "Mrs. Smith's passing", 'terminal diagnosis', 'had a stroke', 'hospitalized in May',
  'in the hospital', 'chemo', "Parkinson's", 'moving to memory care', 'moving to a care home', 'elderly owner',
  'letters of administration', 'matrimonial action', 'custody dispute', 'former husband', 'owner passed on in 2024',
  'estate sale', 'probate', 'divorce', 'the estate is selling', 'executor', 'heirs', 'widowed', 'passed away',
  'Owner passed\nThree units.', 'the owner passed\nand the kids want to sell',
]

test('every phrasing the review probe found missed is caught', () => {
  const missed = SHOULD_CATCH.filter(s => !mentions(s))
  assert.deepEqual(missed, [])
})

test('every ordinary phrase the review probe found wrongly caught is kept', () => {
  const caught = SHOULD_KEEP.filter(s => mentions(s))
  assert.deepEqual(caught, [])
})

test('an owner who "passed" on, over or up something, or passed a check, is ordinary; any other "passed" is a death', () => {
  for (const s of [
    'The seller passed over the lowball bid.', 'He passed on our counteroffer.', 'Owner passed up our offer.',
    'The landlord passed on renewing.', 'She passed on the house.', 'They passed on it last week.',
    'The owner has passed the board interview.', 'The owner passed title at closing.', 'Owner passed the lead to me.',
    'The owner passed by the property yesterday.', 'Showed it to the Smiths; they passed.',
  ]) assert.equal(mentions(s), false, s)
  for (const s of [
    'The owner passed on Tuesday.', 'Owner passed suddenly.', 'The landlord passed last spring.', 'Mr. Smith passed last year.',
    'Mrs. Jones has passed.', 'The owner, who passed in 2023, left it to her kids.', 'He passed in his sleep.',
    'She passed the house to her son.', 'The house was passed down to the kids.', 'Owner passed', 'the seller passed.',
  ]) assert.equal(mentions(s), true, s)
})

test('separating and splitting up are a couple\'s only when nothing they act on follows', () => {
  for (const s of ['Owner is separating the two units.', 'Owners are splitting up the building into condos.',
    'The garage is separated from the house.', 'The lots were separated by a 10-foot alley.', 'Breaking up the concrete in the yard.']) {
    assert.equal(mentions(s), false, s)
  }
  for (const s of ['The couple is separating.', 'The couple broke up.', 'The owners are splitting up.', 'They separated last year.']) {
    assert.equal(mentions(s), true, s)
  }
})

test('illness, care and age wording is caught; the same words as places or idioms are kept', () => {
  for (const s of ['Owner is in hospice.', 'Owner had a heart attack.', 'Owner is undergoing chemotherapy.', 'Owner was diagnosed with cancer.',
    'Owner needs a caregiver.', 'Owner is in a nursing home.', 'Moving into assisted living.', 'Owner was rushed to the hospital.',
    'Elderly couple selling.', 'Aging owner wants out.', 'Senior citizen owner.', '85-year-old owner.', 'Owner is in her 80s.',
    'Owner in his late seventies.', 'Selling for family reasons.', 'Owner has health issues.']) {
    assert.equal(mentions(s), true, s)
  }
  for (const s of ['Two blocks from Methodist Hospital.', 'Near the hospital and the park.', 'Next door to an assisted living facility.',
    'Converted funeral home, now a three-family.', 'Owner is sick of managing tenants.', 'A stroke of luck: the zoning allows a fourth floor.',
    'Built in the late 1920s.', 'Roof replaced in the late 90s.', 'Late fee waived.', 'Great for a growing family.',
    'Owner retiring to Florida.', 'The deal died in attorney review.', 'Purchaser will inherit the existing leases.']) {
    assert.equal(mentions(s), false, s)
  }
})

test('"<Name> Estates" is a place; an estate that sells is not', () => {
  for (const s of ['Fieldston Estates colonial', 'Jamaica Estates single family']) assert.equal(mentions(s), false, s)
  for (const s of ['The Smith Estates are selling the brownstone.', 'The Estates of the late owner.', 'Smith estate is selling.']) assert.equal(mentions(s), true, s)
})

test('sentence handling: only the pieces that mention one are dropped', () => {
  const cases: Array<[string, string]> = [
    ['Three-family in Bed-Stuy. Owner passed two months ago. Asking $1.8M.', 'Three-family in Bed-Stuy. Asking $1.8M.'],
    // A sentence that starts with no space after the full stop
    ['Owner wants to list.Divorce pending. Three units.', 'Owner wants to list. Three units.'],
    ['Asking $1.2M. Owner died. 3 units.', 'Asking $1.2M. 3 units.'],
    ['Seller is the executor (her late husband’s estate). Two units.', 'Two units.'],
    // Clauses between spaced dashes or semicolons
    ['Owner wants to list - divorce pending - three units', 'Owner wants to list - three units'],
    ['Owner wants to list; divorce pending; three units.', 'Owner wants to list; three units.'],
    // Nothing sensitive: unchanged
    ['Great 2-family. Buyer would inherit tenants. Drop-dead views.', 'Great 2-family. Buyer would inherit tenants. Drop-dead views.'],
    // "passed" at the end of a line, with no full stop
    ['Owner wants to list.\nOwner passed\nThree units.', 'Owner wants to list. Three units.'],
    ['U.S. buyer. Owner died. N.Y. Two units.', 'U.S. buyer. N.Y. Two units.'],
  ]
  for (const [input, expected] of cases) assert.equal(without(input), expected, input)
  assert.equal(sellerSummary('Owner wants to list.', 'estate sale'), 'Owner wants to list.')
  assert.equal(sellerSummary('Owner wants to list.', 'They’re splitting up'), 'Owner wants to list.')
})
