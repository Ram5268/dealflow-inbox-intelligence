// Brief 41.1 (review F4) — the personal-circumstances filter on the phrasings
// the Brief 41 review probe (filter-probe.ts) found it missing or wrongly
// catching, the PR G review's cases, and how it splits text. Pure: imports
// only the filter.
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
    'Seller passed it along to her attorney.', 'He passed me the keys.', 'Who passed the listing to me?', 'The owner passed at $1.8M.',
    'Owner passed at asking.', 'Seller passed for now.', 'Owner passed — not interested.', 'Owner passed because the price was too low.',
    'Her son passed the co-op board interview.', "The owner's son passed on our offer.",
  ]) assert.equal(mentions(s), false, s)
  for (const s of [
    'The owner passed on Tuesday.', 'Owner passed suddenly.', 'The landlord passed last spring.', 'Mr. Smith passed last year.',
    'Mrs. Jones has passed.', 'The owner, who passed in 2023, left it to her kids.', 'He passed in his sleep.',
    'She passed the house to her son.', 'The house was passed down to the kids.', 'Owner passed', 'the seller passed.',
    // PR G review: a word or an aside before "passed", and a partner
    'The owner unfortunately passed in May.', 'The owner has now passed.', 'The owners both passed.', 'The owner recently and unexpectedly passed.',
    'The owner, John Smith, passed in March.', 'The owner, sadly, passed.', 'Her husband unfortunately passed.', 'After his partner passed, he wants out.',
    'The seller passed this time last year.', 'Her husband passed on in 2020.',
  ]) assert.equal(mentions(s), true, s)
})

test('separating and splitting up are a couple\'s only when nothing they act on follows', () => {
  for (const s of ['Owner is separating the two units.', 'Owners are splitting up the building into condos.',
    'The garage is separated from the house.', 'The lots were separated by a 10-foot alley.', 'Breaking up the concrete in the yard.',
    // PR G review nits: things, not people
    'The bedrooms are separated.', 'Unit 3 is separated from unit 4.', 'Gas and electric are separated.', "The lot can't be split up.",
    'They split the commission.', 'A breakup fee applies.']) {
    assert.equal(mentions(s), false, s)
  }
  for (const s of ['The couple is separating.', 'The couple broke up.', 'The owners are splitting up.', 'They separated last year.',
    'Owner is going through a separation.', 'After their breakup, they are selling.', 'After their break-up, the house is for sale.',
    'The couple split last year.', 'The couple is parting ways.', "His soon-to-be ex wants to sell.", "The owner's ex wants half.",
    'Their marriage ended.', 'Family court ordered the sale.', 'Husband moved out.']) {
    assert.equal(mentions(s), true, s)
  }
})

test('illness, care and age wording is caught; the same words as places or idioms are kept', () => {
  for (const s of ['Owner is in hospice.', 'Owner had a heart attack.', 'Owner is undergoing chemotherapy.', 'Owner was diagnosed with cancer.',
    'Owner needs a caregiver.', 'Owner is in a nursing home.', 'Moving into assisted living.', 'Owner was rushed to the hospital.',
    'Elderly couple selling.', 'Aging owner wants out.', 'Senior citizen owner.', '85-year-old owner.', 'Owner is in her 80s.',
    'Owner in his late seventies.', 'Selling for family reasons.', 'Owner has health issues.',
    // PR G review: hyphenated forms
    'Owner is moving to an assisted-living facility.', 'Mom is going into a nursing-home.', 'Moving to memory-care.', 'Moving into a care-home.',
    'Needs a home-health aide.', 'Owner is in ill-health.',
    // incapacity
    'Son has power of attorney.', 'Court-appointed guardian is selling.', 'A conservator was appointed.', 'Owner is incapacitated.',
    // illness and death
    'Owner is unwell.', 'Owner had surgery.', 'Owner is disabled.', 'The surviving spouse wants to sell.', 'The beneficiaries want to sell.',
    'Owner is terminal.', 'Owner is terminally\nIll and in a nursing home.', 'Owner is in the ICU.', 'Owner is bedridden.', 'Owner needs full-time care.',
    // age tied to a person
    'Owner is 85 years old.', 'Owner is 85.', 'The owner, 82, wants to downsize.', 'Owner is a senior.', 'Older couple selling.',
    'Owner is getting older.', 'Retired couple selling.', "She's 85 and selling.", "He's disabled.",
    // a building type someone moves into is not a building listing
    'Owner is moving to an assisted living building.', 'Moving to an old nursing home near her daughter.', 'Moving to senior living.']) {
    assert.equal(mentions(s), true, s)
  }
  for (const s of ['Two blocks from Methodist Hospital.', 'Near the hospital and the park.', 'Next door to an assisted living facility.',
    'Converted funeral home, now a three-family.', 'Owner is sick of managing tenants.', 'A stroke of luck: the zoning allows a fourth floor.',
    'Built in the late 1920s.', 'Roof replaced in the late 90s.', 'Late fee waived.', 'Great for a growing family.',
    'Owner retiring to Florida.', 'The deal died in attorney review.', 'Purchaser will inherit the existing leases.',
    // PR G review: ages of things, and building types as buildings
    'The building is 100 years old.', 'Two brownstones. They are 100 years old.', 'The owner is 20 minutes away.', 'Owner is a senior partner at a law firm.',
    'Funeral home for sale.', 'Nursing home for sale.', 'Mixed-use with a funeral home on the ground floor.', 'Former nursing home, now vacant.',
    // PR G review nits
    'Disability access ramp.', 'Escrow custody account.', 'Home health agency tenant on the first floor.', 'Dialysis center tenant.',
    'In the hospital district.', 'The boiler died last winter.', 'Market is dead.']) {
    assert.equal(mentions(s), false, s)
  }
})

test('a buyer inherits the tenants or the lease; anyone "inheriting" is an inheritance', () => {
  for (const s of ['You will inherit two tenants.', 'Buyer inherits the lease.', 'Inherit a rent-stabilized tenant.']) assert.equal(mentions(s), false, s)
  for (const s of ['The kids are inheriting the tenants and the house.', 'Her son is inheriting the rent roll.', 'She inherited the tenants.']) {
    assert.equal(mentions(s), true, s)
  }
})

test('"<Name> Estates" is a place; an estate that sells is not; the words before the place are still checked', () => {
  for (const s of ['Fieldston Estates colonial', 'Jamaica Estates single family', 'Jamaica Estates colonial, owner is relocating.']) {
    assert.equal(mentions(s), false, s)
  }
  for (const s of ['The Smith Estates are selling the brownstone.', 'The Estates of the late owner.', 'Smith estate is selling.',
    // PR G review (blocker): Title Case words before the place name, and the verb in any case
    'Inherited Jamaica Estates Colonial', 'Probate Jamaica Estates Listing', 'Widowed Jamaica Estates owner wants to list.',
    'Inherited Jamaica Estates colonial with a finished basement.', 'The Smith Estates Are Selling The Brownstone.',
    'Heirs Bayside Estates', 'Family Estates Liquidation', 'Probate Estates condo for sale.']) {
    assert.equal(mentions(s), true, s)
  }
  assert.equal(without('Inherited Jamaica Estates colonial with a finished basement. Asking $1.4M.'), 'Asking $1.4M.')
})

test('sentence handling: only the sentences or lines that mention one are dropped', () => {
  const cases: Array<[string, string]> = [
    ['Three-family in Bed-Stuy. Owner passed two months ago. Asking $1.8M.', 'Three-family in Bed-Stuy. Asking $1.8M.'],
    // A sentence that starts with no space after the full stop
    ['Owner wants to list.Divorce pending. Three units.', 'Owner wants to list. Three units.'],
    ['Asking $1.2M. Owner died. 3 units.', 'Asking $1.2M. 3 units.'],
    ['Seller is the executor (her late husband’s estate). Two units.', 'Two units.'],
    // A sensitive clause drops its whole sentence, with the context around it (PR G review: privacy wins)
    ['Owner wants to list - divorce pending - three units', ''],
    ['Owner wants to list; divorce pending; three units.', ''],
    ['Divorce pending; wife keeps the house; husband wants cash. Three units.', 'Three units.'],
    ['Owner passed in March; the kids want to sell fast. Three units.', 'Three units.'],
    ['Owner is moving to assisted living - her son will handle the sale. Three units.', 'Three units.'],
    ['The owner — who passed in March — left it to her kids. Three units.', 'Three units.'],
    // A web address or an email is never split (PR G review)
    ['See www.Example.com for photos. Owner died. Three units.', 'See www.Example.com for photos. Three units.'],
    ['Seller is jane.Doe@example.com. Owner died. Three units.', 'Seller is jane.Doe@example.com. Three units.'],
    ['Probate.Two units.', 'Two units.'],
    ['Owner wants to list\r\nDivorce pending\r\nThree units.', 'Owner wants to list Three units.'],
    ['Prof. Smith died. Three units.', 'Three units.'],
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

// PR G review, round 3: an "ordinary" exception is narrow, tied to a building,
// listing or deal, and never applies when a person is the subject.
test('a medical center is ordinary only as a tenant or a space, never where someone is treated', () => {
  for (const s of ['Owner is in treatment at the cancer center.', 'Her husband is being treated at a cancer center.',
    'Owner goes to the cancer center every week.', 'Owner was admitted to a cancer facility.', 'Owner spends her days at the cancer clinic.',
    'Owner sees doctors at the cancer practice.', 'Owner goes to the dialysis center three times a week.', 'Owner is at a chemo clinic daily.',
    'Owner is at a rehab facility after her fall.', 'Owner is in a medical facility.']) {
    assert.equal(mentions(s), true, s)
  }
  for (const s of ['Dialysis center tenant.', 'Cancer center tenant on the ground floor.', 'Urgent care tenant.']) assert.equal(mentions(s), false, s)
})

test('a relative who "passed" is a death unless they passed on an offer or passed a check', () => {
  for (const s of ['Her husband passed around Christmas.', 'Her husband passed around the holidays.', 'His wife passed by the time the house was listed.',
    'Her father passed along with her mother in the crash.', 'Her father passed on the house to her.', 'Her father passed on the house to her two years ago.',
    'Her mother passed her the house.', 'Her father passed us the house.', 'His father passed him the brownstone.', 'Her mother passed it along to her.',
    'Her father passed the building to me.', 'Her husband passed, no thanks to the doctors.', 'Her husband passed at home.', 'Her father passed at asking.',
    'Her husband passed for now.', 'Her husband passed up north.', 'Her husband passed over the summer.', 'Her mother passed on Christmas.',
    'Her father passed on the house.', 'Her mother passed on it.']) {
    assert.equal(mentions(s), true, s)
  }
  for (const s of ['Her son passed the co-op board interview.', "The owner's son passed on our offer.", 'Her son passed the bar.',
    'Her son passed his driving test.', 'Her husband passed on buying it.']) {
    assert.equal(mentions(s), false, s)
  }
})

test('an owner\'s "declined" exceptions are narrow: no "around", no passing the property, "no thanks" only at the end', () => {
  for (const s of ['The owner passed, no thanks to her doctors.', 'Owner passed — no thanks to the bank.', 'The owner passed around Christmas.',
    'The owner passed by the end of the year.', 'Seller passed through a long illness.', 'The owner passed at 92.', 'The owner passed at home.',
    'She passed the house to her son.', 'The owner passed on the house to her son.', 'The landlord passed this time last spring.']) {
    assert.equal(mentions(s), true, s)
  }
  for (const s of ['Owner passed — not interested.', 'Owner passed, no thanks.', 'He passed me the keys.', 'Who passed the listing to me?',
    'Seller passed it along to her attorney.', 'The owner passed by the property yesterday.', 'Owner passed at asking.', 'Seller passed for now.']) {
    assert.equal(mentions(s), false, s)
  }
})

test('passing away, passes, may pass: the present and the future too', () => {
  for (const s of ['Owner is passing away.', 'When he passes away the kids will sell.', 'When she passes, the kids will sell.',
    'Her husband is passing.', 'Owner may pass soon.']) {
    assert.equal(mentions(s), true, s)
  }
  for (const s of ['The owner is passing on the deal.', 'The seller passes the board review.', 'Owner is passing through town.']) assert.equal(mentions(s), false, s)
})

test('a nursing home as a building, never where someone is; a lead is a person; a family member inheriting is an inheritance', () => {
  for (const s of ['Her mother is in assisted living on the second floor of the building.', 'Her mother is in a nursing home on the top floor.',
    'Owner lives next to the nursing home where his wife is.', 'Owner moved to be near the assisted living facility where her husband lives.',
    'Owner moved next door to the nursing home to be close to his wife.', 'Owner is near a funeral home for her husband.',
    'The seller lead died in March.', 'Our seller lead died last month.', 'The market died with the owner.', "The owner's car died and so did he.",
    'Her husband is dead weight on the sale.', 'Her daughter will inherit the tenants.', 'The kids inherit the tenants when she passes.',
    'His son inherits the lease from him.', 'Johnson Estates hired a lawyer to sell the house.', "The Miller Estates' attorney called.",
    'Brown Estates Inc is selling.', 'The Smith and Jones Estates agreed to sell.']) {
    assert.equal(mentions(s), true, s)
  }
  for (const s of ['Mixed-use with a funeral home on the ground floor.', 'Nursing-home building for sale.', 'Across from a nursing home.',
    'Next door to an assisted living facility.', 'The house is next to a nursing home.', 'The deal died in attorney review.', 'Drop-dead skyline views from the roof.',
    'Buyer will inherit two rent-stabilized tenants.', "You'll inherit the existing lease.", 'Inherit the tenants.',
    'Kensington Estates co-op unit', 'Bayside Estates two-family', 'Single-family home in Fresh Meadows Estates, Queens.']) {
    assert.equal(mentions(s), false, s)
  }
  // A blank line ends a paragraph; a lowercase line carries on the one before.
  assert.equal(without('Three units\n\nowner died'), 'Three units')
})

test('the filter and the fit line stay fast on long inputs (round 3 review: no quadratic splits)', () => {
  const started = Date.now()
  without('Owner died\n' + 'abc\n'.repeat(200_000))
  without('Owner died.' + ' '.repeat(100_000) + 'x')
  without('Owner died.' + '\n '.repeat(50_000) + 'x')
  assert.ok(Date.now() - started < 3_000, `${Date.now() - started} ms`)
})

// PR G review, round 4: the building, care, dead-thing, custody, inheriting and
// separation exceptions switch off in a sentence that is about a person.
test("a care place is a building only when the sentence isn't about someone's care", () => {
  for (const s of ['Owner is looking for a condo near an assisted living facility where her mother is.',
    'Owner bought a place near a nursing home, to be close to her mother.', 'Her mother lives in the nursing home building on the third floor.',
    'Her mother is a nursing home tenant.', "Owner's wife resides next to the nursing home that cares for her.", 'Her husband is a cancer center tenant.',
    'Owner needs disability access.', 'Seller is moving because she needs disability access.', 'The owner needs a disability ramp.',
    'Owner uses a home health agency.', 'A home health agency sends an aide to the owner.', 'Mom is going into the nursing home for rent support.',
    'Owner is buying near an assisted living to be close to her mother.', 'Owner needs the dialysis center space.']) {
    assert.equal(mentions(s), true, s)
  }
  for (const s of ['Across from a nursing home.', 'Former funeral home, zoned R6.', 'Mixed-use with a funeral home on the ground floor.',
    'Owner is selling a former funeral home.', 'Owner is selling a former nursing home.', "The owner's building is next to a nursing home.",
    'Owner wants to list the funeral home for sale.', 'Seller owns a nursing home building on the ground floor.', 'Dialysis center tenant.',
    'Disability access ramp.', 'Home health agency tenant on the first floor.', 'Next door to an assisted living facility.']) {
    assert.equal(mentions(s), false, s)
  }
})

test('a dead thing, custody, inheriting and separated rooms are ordinary only when no one is in the sentence', () => {
  for (const s of ['The listing died in March, as did the owner.', 'The loan died, then so did the owner.', 'The car died in the crash that killed him.',
    'The deal died with the seller.', 'She has custody of the files and the kids.', 'Her son becomes the new owner; inherits the tenants.',
    'Her son, the new owner, inherits the tenants.', "The couple's bedrooms are separated."]) {
    assert.equal(mentions(s), true, s)
  }
  for (const s of ['The deal died in attorney review.', 'The boiler died last winter.', 'Custody of the keys is with the super.',
    'Buyer inherits the lease.', 'The bedrooms are separated.']) {
    assert.equal(mentions(s), false, s)
  }
})

test('title to the family, "<Name> Estates" as a party, prognosis, and a name before "passed"', () => {
  for (const s of ['Her father passed title to her.', 'Her father passed title to his grandson.', 'Her mother passed the title to her son.',
    'The owner passed the title to his son.', 'The attorney is acting on behalf of the Johnson Estates.', 'Proceeds go to the Smith Estates.',
    'The house was left to the Rivera Estates.', 'Funds from the Miller Estates will pay the taxes.', 'Johnson Estates properties are being sold.',
    'Sale of the Johnson Estates holdings.', 'The owner passed, not interested in treatment anymore.', 'The owner is not expected to live much longer.',
    'The owner has months to live.', 'Owner does not have long to live.', 'The owner is at the end of life.', 'Owner is on his deathbed.',
    'Owner is on life support.', 'Owner is in a coma.', 'Owner is in critical condition.', 'Owner Jane Smith passed in March.',
    'The owner passed on that very day.', 'She passed on one of the coldest days of the year.', 'The owner passed on us last spring.',
    'Owner passed on it in her sleep.', 'The owner recently and very suddenly passed.', 'The owner left us last year.']) {
    assert.equal(mentions(s), true, s)
  }
  for (const s of ['Single-family home in Fresh Meadows Estates.', 'Kensington Estates co-op', 'Estates at Brooklyn Heights', 'Bayside Estates two-family',
    'The owner passed title at closing.', 'Owner passed, not interested in selling.', 'Owner passed: not interested at that price.', 'She passed on it.']) {
    assert.equal(mentions(s), false, s)
  }
})
