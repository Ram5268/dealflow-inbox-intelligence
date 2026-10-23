// Brief 43 PR 10 (Q17): the guard-accuracy rows, shared by
// guardAccuracy.unit.test.ts and the before/after check of the old guard.
// Fictional names, addresses and 555-01xx phones only.
import type { ToolResultForVerify } from '../llmVerifier'
import { formatForChat, type ACRISResult } from '../../../acris'
import { GRAPH_PAUSED_CALENDAR_BLOCK } from '../../../graphAccess'

// ── This turn's side lookups, shaped as the route builds them ────────────────
// (composeContext's blocks, joined and trimmed into dynamicSystemBlock).
export const ACRIS_RESULT: ACRISResult = {
  inputAddress: '88 Example Ave, Brooklyn',
  normalizedStreetNumber: '88',
  normalizedStreetName: 'EXAMPLE AVENUE',
  borough: '3',
  block: '1',
  lot: '1',
  currentOwner: 'SAMPLE, JORDAN',
  lastSaleDate: '2019-05-02',
  lastSalePrice: 1_200_000,
  lastSaleSeller: 'EXAMPLE, PAT',
  priorSaleDate: '2011-03-15',
  priorSalePrice: 640_000,
  currentMortgageAmount: 900_000,
  currentMortgageDate: '2019-05-02',
  currentMortgageLender: 'SAMPLE SAVINGS BANK',
  isCoOp: false,
  transfers: [],
  fetchedAt: '2026-10-19T00:00:00.000Z',
  // Brief 43 PR 11: no other tax lot shares this street address.
  otherLotsAtAddress: 0,
}
export const MORTGAGE = '\nMARKET RATE: 30-year fixed mortgage rate: 6.30% (week of 2026-10-09) — unchanged'
export const ACRIS = `\n\n${formatForChat(ACRIS_RESULT)}`
export const ACRIS_LLC = `\n\n${formatForChat({ ...ACRIS_RESULT, currentOwner: '88 EXAMPLE HOLDINGS LLC' })}`
// Brief 43 PR 11's "nothing on file" block.
export const ACRIS_NONE = '\n\nACRIS PROPERTY RECORDS — 88 Example Ave, Brooklyn\nNo deed records on file for this address in Brooklyn.'
export const DOB = '\n\nDOB RECORDS — 88 EXAMPLE AVE\n\nPERMIT ACTIVITY (1 recent):\n  Jun 2020 — A2 PL: replace plumbing fixtures [SIGNED OFF]'
export const SE =
  '\n\nLIVE STREETEASY LISTINGS (active on market, filtered to exact criteria):\n' +
  '- $3,900 | https://streeteasy.com/rental/1234567\n- $4,100 | https://streeteasy.com/rental/1234568' +
  '\n\nBrowse all matching listings on StreetEasy: https://streeteasy.com/for-rent/bedford-stuyvesant'
// Brief 43 PR 4's note when a lookup runs out of time: it names the source but
// fetched nothing, so it must not ground a citation.
export const SE_TIMED_OUT = "\n\nLOOKUP NOTE: live StreetEasy didn't answer in time, so it's missing here. If the question needed it, tell Ryan in one short line."
export const MOJO_LLC = '\n\nMOJO SELLER LEADS (1 contacts from CRM):\n[MOJO:c1] Example Street Holdings LLC | 12 Sample St, Brooklyn | Bedford-Stuyvesant | active | sellers | ph: (718) 555-0142'

export const side = (...blocks: string[]) => [MORTGAGE, ...blocks, GRAPH_PAUSED_CALENDAR_BLOCK].join('').trim()

export const LLC_SELLERS: ToolResultForVerify[] = [{
  name: 'search_parties',
  input: { role: 'seller', neighborhoods: ['Bedford-Stuyvesant'] },
  output: {
    cards: [
      { id: 'c1', category: 'MOJO_LEAD', name: 'Example Street Holdings LLC', phone: '(718) 555-0142', neighborhood: 'Bedford-Stuyvesant', role: 'seller' },
      { id: 'c2', category: 'MOJO_LEAD', name: 'Sample Row Partners LLC', phone: '(718) 555-0143', neighborhood: 'Bedford-Stuyvesant', role: 'seller' },
    ],
    totalMatched: 2,
  },
}]

// The prior turn's cards as the route stores them (dealsJson): full rows, with
// the StreetEasy link the route adds. Drift doesn't see these this turn.
export const PRIOR_CARDS = [{
  id: 'SEED_SALE_09', extractedTitle: '3-family in Bed-Stuy', address: '12 Sample St',
  streetEasyUrl: 'https://streeteasy.com/sale/1234569',
  rawEmail: { bodyContent: 'New on StreetEasy and the MLS this week. Owner: Casey Placeholder.' },
}]

export interface Turn { side?: string | null; tools?: ToolResultForVerify[]; prior?: unknown; userMessage?: string }

// ── Brief 43 §4 PR 10's table, drift-2 p3 / p3b, and the targets ─────────────
export type Row = [label: string, reply: string, turn: Turn]
export const PASS: Row[] = [
  // §4 table: a real deed fact with the ACRIS block present.
  ['table: deed owner and sale, block present (p3 P-01)', 'The current owner is Jordan Sample, per ACRIS. It last sold in 2019 for $1,200,000.', { side: side(ACRIS) }],
  ['p3 P-02: last sale with the date', 'It last sold on 2019-05-02 for $1,200,000.', { side: side(ACRIS) }],
  ['p3 P-04: prior owner from the block', 'Before that, the previous owner was Pat Example.', { side: side(ACRIS) }],
  ['p3: plain wording, block present', 'City records show Jordan Sample as the deed owner. The last deed was recorded May 2, 2019 at $1,200,000.', { side: side(ACRIS) }],
  ['DRIFT_SCRIPT #21: owner, deed date and price (D1)', 'The deed owner is Jordan Sample, from city records. The deed was recorded on 2019-05-02 at $1,200,000.', { side: side(ACRIS) }],
  ['#21: owner name in ACRIS order', 'Per ACRIS, the owner is SAMPLE, JORDAN. It last sold for $1,200,000 in 2019.', { side: side(ACRIS) }],
  ['#21: short millions and the prior sale', 'It last sold in 2019 for $1.2M; the previous sale was in 2011 for $640,000.', { side: side(ACRIS) }],
  ['#21: previous owner with a colon', 'Previous owner: Pat Example.', { side: side(ACRIS) }],
  ['#21: an LLC owner from the block', 'The owner is 88 Example Holdings LLC, per ACRIS.', { side: side(ACRIS_LLC) }],
  ['#21: the sold-by party', 'Pat Example sold it to Jordan Sample in 2019 for $1,200,000.', { side: side(ACRIS) }],
  ['PR 11 nothing-on-file block: no deed records', 'ACRIS has no deed records on file for 88 Example Ave in Brooklyn.', { side: side(ACRIS_NONE) }],
  ['DOB citation with the DOB block', 'DOB shows one permit there, a 2020 plumbing job that was signed off.', { side: side(DOB) }],
  ['live StreetEasy citation with its block', 'Live StreetEasy shows two rentals that fit, at $3,900 and $4,100 a month. The Search StreetEasy button below opens the full search.', { side: side(SE) }],
  ['StreetEasy citation with only the fallback browse line', 'StreetEasy has more that fit; the Search StreetEasy button below opens them.', { side: side('\n\nBrowse matching listings on StreetEasy: https://streeteasy.com/for-rent/bedford-stuyvesant') }],
  // §4 table: "I can't check Zillow" and p3b's decline.
  ['table: I can\'t check Zillow', "I can't check Zillow.", {}],
  ['p3b: I can\'t check Zillow or StreetEasy from here', "I can't check Zillow or StreetEasy from here.", {}],
  ['decline: no MLS access', "I don't have access to the MLS, so I can't confirm whether it expired.", {}],
  ['decline: MLS access, source inside the phrase', "I don't have MLS access.", {}],
  ['decline: source first', "Zillow and Redfin aren't something I can check.", {}],
  ['decline: curly apostrophe', 'I can’t check Zillow, Trulia or Redfin.', {}],
  ['decline: no access to', 'There is no access to PropertyShark from here.', {}],
  ['decline: I\'m not able to', "I'm not able to pull MLS data.", {}],
  ['offer: deed and permit records for an address', 'I can look up the ACRIS deed records and DOB permits for an exact address.', {}],
  ['offer: want me to check StreetEasy?', 'Want me to check live StreetEasy for more in Bed-Stuy?', {}],
  ['pointer: StreetEasy\'s neighborhood guides', "For that, I'd point you toward StreetEasy's neighborhood guides.", {}],
  ['pointer: you could check Zillow', 'You could check Zillow for its estimate.', {}],
  ['offer: pull the records if you give an address', "If you give me the house number, I'll pull the ACRIS records for it.", {}],
  // §4 table: "Two LLC-owned sellers" (S-09) and variants.
  ['table: Two LLC-owned sellers', 'Two LLC-owned sellers in Bed-Stuy fit that buyer.', { tools: LLC_SELLERS }],
  ['LLC-owned with no tool result', 'Two LLC-owned sellers fit.', {}],
  ['an LLC, no name', 'Both are held in an LLC.', {}],
  ['Is it an LLC?', 'Is it an LLC? The card does not say.', {}],
  ['The LLC, no name', 'The LLC behind it is not on file.', {}],
  ['Quarterly LP update report name', "The Quarterly LP Update report isn't available yet.", {}],
  ['named LLC sellers from this turn\'s tool results (Brief 11.0)', 'Example Street Holdings LLC and Sample Row Partners LLC are both in Bed-Stuy.', { tools: LLC_SELLERS }],
  ['an LLC from this turn\'s CRM side block', 'Your CRM has Example Street Holdings LLC at 12 Sample St.', { side: side(MOJO_LLC) }],
  // DRIFT_SCRIPT #8: an honest "no record" stays as written.
  ['#8 target: I don\'t have a record of that sale', "I don't have a record of that sale.", { userMessage: 'the 3-family on Halsey that sold for $2.1M last week, who bought it?' }],
  ['#8: no record, then the offer', "I don't have a record of that sale. Give me the house number and I'll look up the deed records.", { userMessage: 'the 3-family on Halsey that sold for $2.1M last week, who bought it?' }],
  ['#8: no record, then an offer naming the source', "I don't have a record of that sale. If you give me the house number on Halsey, I can pull the deed records from ACRIS.", {}],
  ['#8: no record of who bought it or when it last sold', "I don't have a record of who bought it or when it last sold.", {}],
  ['#8: no record of the previous owner of an address', "I don't have a record of the previous owner of 88 Example Ave.", {}],
  ['#8: echoes the question without a year', "I don't have a record of a 3-family on Halsey selling for $2.1M last week.", {}],
  ['offer: look up when it last sold', 'Want me to look up when it last sold?', {}],
  ['no record: not sure who', "I'm not sure who it was sold to.", {}],
  ['no record: can\'t confirm when', "I can't confirm when it last sold.", {}],
  ['conditional: whether it was sold', 'I can check whether it was sold to anyone recently.', {}],
  ['offer: if you give me the address', 'If you give me the address, I can look up when it last sold and who owns it.', {}],
  ['the owner is not on file', 'The owner is not on file for that one.', {}],
  // Everyday replies, unchanged.
  ['DRIFT_SCRIPT #2 self-description', "I can search listings, buyer and renter requests, and your CRM sellers; build Buyer Match reports; draft emails and texts for you to send; and look up deed and permit records and today's mortgage rate. I can't send anything, make calls, book your calendar while Outlook is off, or browse other websites. Where would you like to start?", {}],
  ['listing line', '461 6th St, 2BR in Park Slope, is an active sale at $1,750,000.', {}],
  ['realtor.com as a name in a decline', "I can't check Realtor.com.", {}],
  // Brief 43 PR 10 review: more honest declines, pointers and market talk.
  ['review: a hedge with an unnamed next step', "I'm not sure who it was sold to, so I'd probably start with the deed records.", {}],
  ['review: "maybe I can" names no one', "I'm not sure who it was sold to, maybe I can look it up if you give me the address.", {}],
  ["review: I'd need the house number to check ACRIS", "To see who bought it, I'd need to check ACRIS with the exact address.", {}],
  ["review: I won't be able to check StreetEasy", "I won't be able to check StreetEasy for that.", {}],
  ["review: no StreetEasy data", "I don't have MLS or StreetEasy sold data, so I can't confirm that sale.", {}],
  ['review: ACRIS needs an exact address', 'ACRIS needs an exact address, so give me the house number.', {}],
  ['review: #8, recent deeds take weeks', "I don't have a record of that sale. Recent sales can take a few weeks to show up in ACRIS.", { userMessage: 'the 3-family on Halsey that sold for $2.1M last week, who bought it?' }],
  ['review: a pointer to StreetEasy', 'Try StreetEasy for sold comps.', {}],
  ['review: market talk, no name', 'Developers purchased the lots along Atlantic.', {}],
  ['review: the previous owner is the seller', 'The previous owner is Pat Example.', { side: side(ACRIS) }],
  ['decline: I don\'t have the MLS', "I don't have the MLS.", {}],
  ['decline: no MLS access here', 'No MLS access here.', {}],
  ['decline: without MLS access', "Without MLS access I can't confirm it expired.", {}],
  ['decline: only the inbox, not the MLS', "I only see what's in your inbox, not the MLS.", {}],
  ['prediction: ACRIS will show the owner', 'Once I have the address, ACRIS will show the owner.', {}],
  ['prediction: it would be in ACRIS', 'That would be in ACRIS once the deed is recorded.', {}],
  ['market talk: Brooklyn buyers', 'Most Brooklyn Buyers bought the same way.', {}],
  ['S-09: owned by LLCs, with LLC sellers this turn', 'Three of them are owned by LLCs.', { tools: LLC_SELLERS }],
  ['S-09: owned by an LLC, with LLC sellers this turn', 'That one is owned by an LLC.', { tools: LLC_SELLERS }],
  ['the Quarterly LP report, asked as a question', 'Want me to draft the Quarterly LP?', {}],
  ['review: a past owner, then the buyer', 'It was owned by Pat Example until 2019, when Jordan Sample bought it for $1,200,000.', { side: side(ACRIS) }],
  // Brief 43 PR 10 review r2: hedges that still pass.
  ['review r2: a pointer that says what the source would have', 'StreetEasy would have the sold comps.', {}],
  ['review r2: a decline as an embedded question', "I can't confirm whether StreetEasy has it.", {}],
  ['review r2: "as well" is no status', 'I can pull the ACRIS records as well.', {}],
  ['review r2: the buyer from the block bought the whole building', 'Jordan Sample bought the whole building in 2019 for $1,200,000.', { side: side(ACRIS) }],
]

export const FLAG: Row[] = [
  // §4 table: the same deed fact without the block.
  ['table: deed owner and sale, no block', 'The current owner is Jordan Sample, per ACRIS. It last sold in 2019 for $1,200,000.', {}],
  ['p3 P-02 without the block', 'It last sold on 2019-05-02 for $1,200,000.', {}],
  ['p3 P-04 without the block', 'Before that, the previous owner was Pat Example.', {}],
  ['invented owner, no ACRIS block', 'The owner is Jordan Sample.', {}],
  ['invented owner, PR 11 nothing-on-file block', 'The owner is Jordan Sample.', { side: side(ACRIS_NONE) }],
  ['wrong owner with the block', 'The current owner is Casey Placeholder, per ACRIS.', { side: side(ACRIS) }],
  ['an invented co-owner with the block', 'The owner is Jordan Sample and Casey Placeholder.', { side: side(ACRIS) }],
  ['wrong previous owner with a colon', 'Previous owner: Casey Placeholder.', { side: side(ACRIS) }],
  ['wrong amount with the block', 'It last sold in 2019 for $1,450,000.', { side: side(ACRIS) }],
  ['wrong year with the block', 'It last sold in 2016 for $1,200,000.', { side: side(ACRIS) }],
  ['wrong dated amount with the block', 'It changed hands at $1,450,000 in 2019.', { side: side(ACRIS) }],
  ['invented LLC owner with the block', 'The owner is Sample Street Holdings LLC.', { side: side(ACRIS) }],
  // §4 table: "per ACRIS" with nothing fetched (p3b).
  ['table: per ACRIS, nothing fetched (p3b)', 'Per ACRIS the deed was recorded last spring.', {}],
  ['per ACRIS with only the DOB block', 'Per ACRIS the deed was recorded last spring.', { side: side(DOB) }],
  ['p3b: StreetEasy shows it, nothing fetched', 'StreetEasy shows it at $1,900,000.', {}],
  ['StreetEasy shows it, only the timed-out note', 'StreetEasy shows it at $1,900,000.', { side: side(SE_TIMED_OUT) }],
  ['per StreetEasy, only the prior turn\'s cards name it', 'Per StreetEasy it is still active.', { prior: PRIOR_CARDS }],
  ['p3b: DOB has two open permits, nothing fetched', 'DOB has two open permits there.', {}],
  ['p3b: MLS shows it as expired', 'MLS shows it as expired.', {}],
  ['p3b: PLUTO lists it as a 3-family', 'PLUTO lists it as a 3-family.', {}],
  ['p3 T-03: Zillow has it at', 'Zillow has it at $1,500,000.', {}],
  ['a decline, then a citation', "I can't check Zillow, but StreetEasy shows it at $1,900,000.", {}],
  ['a decline and a citation in one clause', "I can't verify it, StreetEasy has it at $1,900,000.", {}],
  ['a citation before a decline', "It shows as expired on MLS, which isn't something I can check.", {}],
  ['a pointer with a figure', 'You could check StreetEasy, which shows it at $1,900,000.', {}],
  ['an observation is not an offer', "I can see it's listed on StreetEasy.", {}],
  ['a claimed search result', "I don't see it on StreetEasy.", {}],
  // A URL Drift wrote: always a hard flag, block or no block.
  ['p3 L: live SE link, block present', 'One fits: $3,900 a month, https://streeteasy.com/rental/1234567', { side: side(SE) }],
  ['p3 L: SE link with no scheme, block present', 'One fits: $3,900 a month, streeteasy.com/rental/1234567', { side: side(SE) }],
  ['www link, block present', 'One fits: $3,900 a month at www.streeteasy.com/rental/1234567.', { side: side(SE) }],
  ['a made-up Zillow link', 'See zillow.com/homedetails/88-Example-Ave for the history.', {}],
  // DRIFT_SCRIPT #8: an invented buyer for the made-up sale.
  ['#8: bought by an invented buyer', 'It was bought by Pat Example for $2,100,000.', { userMessage: 'the 3-family on Halsey that sold for $2.1M last week, who bought it?' }],
  ['#8: sold to an invented buyer', 'It sold to Pat Example last week.', {}],
  ['#8: an invented buyer bought it', 'Pat Example bought it last week for $2,100,000.', {}],
  ['#8: an invented LLC buyer', 'Halsey Sample Holdings LLC bought the 3-family.', {}],
  ['#8: no record, then a claim', "I don't have the deed, but it last sold in 2019 for $1,200,000.", {}],
  ['a negation that governs nothing', 'No surprise, it last sold to an investor.', {}],
  ['an offer that governs nothing', 'Let me check the records, it was sold to a developer.', {}],
  ['a pointer, then what the source shows', 'You could check Zillow, which shows it as pending.', {}],
  ['"Before that" is not a hedge', 'Before that, the previous owner sold it to Casey Placeholder.', {}],
  ['#8: a negation with a name after it', 'I have no record of it being sold to Pat Example.', {}],
  // Entities: an invented LLC still fires (Brief 11.0's safety property).
  ['invented LLC prospect', 'You could also reach out to Casey Placeholder Holdings LLC, a strong off-market prospect.', { tools: LLC_SELLERS }],
  ['a prior turn\'s email body grounds neither the source nor the owner', 'Per StreetEasy the owner is Casey Placeholder.', { prior: PRIOR_CARDS }],
  // Brief 43 PR 10 review: a guess after a "no record" hedge (#8), names from the
  // wrong party in the block, and a comma splice after a decline.
  ['review: #8, a guess after "not sure who"', "I'm not sure who it was sold to, maybe Pat Example.", { userMessage: 'the 3-family on Halsey that sold for $2.1M last week, who bought it?' }],
  ['review: a guess past the comma', "I don't know who it was sold to, but I believe it was Pat Example.", {}],
  ['review: a guess past a semicolon', "I don't have a record of who it was sold to; likely Pat Example.", {}],
  ['review: a guessed year', "I'm not sure when it last sold; I think it was 2019.", {}],
  ['review: the lender called the owner', 'The owner is Sample Savings Bank.', { side: side(ACRIS) }],
  ['review: the seller called the current owner', 'The current owner is Pat Example.', { side: side(ACRIS) }],
  ['review: name words mixed from two parties', 'The owner is Pat Sample.', { side: side(ACRIS) }],
  ['review: the owner called the previous owner', 'The previous owner was Jordan Sample.', { side: side(ACRIS) }],
  ['review: a comma splice after a decline', "I can't confirm the price, it's active on StreetEasy.", {}],
  ['review: a comma splice after a decline (Zillow)', "I can't confirm the price, it's on Zillow as pending.", {}],
  ['a prediction with a name', 'ACRIS should list Pat Example as the owner.', {}],
  ['a search result is not a decline', "I don't see StreetEasy listing it.", {}],
  ['a decline, then a claim about the source', "I don't have the MLS, but it expired on StreetEasy.", {}],
  ['ACRIS recorded it, nothing fetched', 'ACRIS recorded the deed last spring.', {}],
  ['owned by an LLC with no LLC fetched this turn', 'That one is owned by an LLC.', {}],
  ['owned by an LLC, then an invented name', 'It is owned by an LLC, Casey Placeholder Holdings LLC.', { tools: LLC_SELLERS }],
  ['generic buyers with a figure are still a sale claim (#8)', 'They bought it last week for $2,100,000.', {}],
  ['generic buyers with a year', 'Developers purchased the lots along Atlantic in 2021.', {}],
  // Brief 43 PR 10 review r2: an invented buyer with "bought the …" (#8), and
  // predictions, pointers and "I only see" that state what an unfetched source has.
  ['review r2: #8, an invented buyer bought the whole 3-family', 'Pat Example bought the whole 3-family for $2.1M.', { userMessage: 'the 3-family on Halsey that sold for $2.1M last week, who bought it?' }],
  ['review r2: an invented buyer bought the other unit', 'Pat Example bought the other unit.', {}],
  ['review r2: a named buyer bought the last one (no record has it)', 'Your Bed-Stuy buyer Pat Example bought the last one you showed.', {}],
  ['review r2: a prediction with a status', 'Zillow would have it as pending.', {}],
  ['review r2: a prediction with a status (MLS)', 'The MLS should show it as expired.', {}],
  ['review r2: a prediction with a role and a name in ACRIS form', 'ACRIS will show SAMPLE, JORDAN as the owner.', {}],
  ['review r2: a prediction with a role and one name', 'ACRIS should list Sample as the owner.', {}],
  ['review r2: an amount without a dollar sign', 'Zillow might have it at around 1.9 million.', {}],
  ['review r2: I only see it on a source', 'I only see it listed on StreetEasy.', {}],
  ['review r2: I only see it on a source, with a status', 'I only see it on Zillow as pending.', {}],
  ['review r2: a search report is not a decline', "I don't see any MLS listing for it.", {}],
  ['review r2: a decline, then a comma claim after the source', "I don't have the Zillow history, it was pending in June.", {}],
]
