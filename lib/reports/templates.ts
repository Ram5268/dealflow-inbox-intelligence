// Brief 27.0 — Report Engine template catalog (Phase 1a).
//
// All 21 report descriptors, transcribed from the standard-issue report library
// (the SHEETS array in report-template-library.html — 6 disciplines, 21 sheets).
// This is the model- and UI-facing source of truth for what a report IS: its
// purpose, its sections, its metrics, and what data it needs to be generatable.
//
// Only M-02 (Buyer Match & Search) is UNLOCKED in Phase 1a — it needs inbox data
// only and has a working generator (lib/reports/generators/buyer-match). Every
// other template is present but locked: it either lacks a generator or needs a
// source integration that isn't wired into a generator yet. A future brief adds
// the generator + flips the lock by registering it in HAS_GENERATOR.

export type Discipline = 'P' | 'U' | 'M' | 'C' | 'I' | 'O'
export type DataSource = 'inbox' | 'acris' | 'pluto' | 'dob' | 'streeteasy' | 'fred'

export type ReportSection = { key: string; title: string; description: string }

export type ReportTemplate = {
  id: string                    // "buyer-match", "cma", etc.
  code: string                  // "M-02", "P-01", etc.
  discipline: Discipline
  disciplineName: string        // "Marketing"
  name: string                  // "Buyer Match & Search Report"
  forWhom: string
  cadence: string
  role: string
  purpose: string
  sections: ReportSection[]
  metrics: string[]
  watch: string
  dataRequirements: DataSource[]
  isUnlocked: boolean           // computed: generator exists AND all data reqs met
}

export const DISCIPLINE_NAMES: Record<Discipline, string> = {
  P: 'Pricing',
  U: 'Underwriting',
  M: 'Marketing',
  C: 'Construction',
  I: 'Investor',
  O: 'Operations',
}

// Sources currently wired and dependable (Brief 25/26 fixed ACRIS/DOB/PLUTO/FRED
// at the lib level; inbox is the DealFlow DB). A template only unlocks once it
// ALSO has a generator — availability here is necessary, not sufficient.
const AVAILABLE_SOURCES = new Set<DataSource>(['inbox', 'acris', 'pluto', 'dob', 'streeteasy', 'fred'])

// Templates with a registered generator. Phase 1a ships exactly one. Future
// briefs add a generator and append its id here to unlock it.
const HAS_GENERATOR = new Set<string>(['buyer-match'])

// Stable kebab-case key from a section title. Deterministic → keys don't drift
// as long as titles don't. M-02 overrides these with hand-picked short keys that
// match its generator's section files (see SECTION_KEY_OVERRIDES).
function kebab(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// M-02's section files are named by short stable keys, not by kebab-of-title.
// The generator (generateBuyerMatchSection) dispatches on these exact keys.
const SECTION_KEY_OVERRIDES: Record<string, string[]> = {
  'M-02': [
    'criteria',
    'matching-inventory',
    'curated-matches',
    'near-misses',
    'off-market',
    'budget-reality',
    'showing-schedule',
    'recommended-adjustment',
  ],
}

// Raw descriptors as they appear in the library, plus per-template data reqs.
// sections are [title, description] tuples; keys are derived below.
type RawSheet = {
  code: string
  disc: Discipline
  id: string                    // our stable template id (kebab of the name)
  name: string
  forWhom: string
  cadence: string
  role: string
  purpose: string
  sections: [string, string][]
  metrics: string[]
  watch: string
  dataRequirements: DataSource[]
}

const RAW_SHEETS: RawSheet[] = [
  // ── P — PRICING ──────────────────────────────────────────────────────────
  {
    code: 'P-01', disc: 'P', id: 'cma',
    name: 'Comparative Market Analysis & Pricing Strategy',
    forWhom: 'Seller / owner', cadence: 'Per listing', role: 'Broker · Agent',
    purpose: 'Turn comparable evidence into a defensible ask, a reserve the seller has already agreed to, and a repricing plan set before launch rather than after disappointment.',
    sections: [
      ['Subject profile', 'Address, line, floor, SF, beds/baths, exposure, condition, monthlies (CC or maintenance + taxes), flip tax, ownership type, board character.'],
      ['Comparable set', '3–6 closed in the last 6–12 months, 3–6 active, 2–4 withdrawn or expired. Same building first, then same line or floor band, then the block.'],
      ['Adjustment grid', "Adjust each comp's $/SF for floor, light and exposure, outdoor space, condition, layout efficiency, and carrying cost. Show the adjustment, not just the result."],
      ['Value conclusion', 'Adjusted $/SF range, indicated value, and a confidence band. Say which comps carry the most weight and why.'],
      ['Market context', 'Absorption, months of supply, list-to-sale ratio, median days on market, and the direction each has moved over two quarters.'],
      ['Pricing strategy', 'Recommended ask, walk-away reserve, and positioning against portal search thresholds — the $1.0M / $1.5M / $2M filter breakpoints move more traffic than the last 2% of price.'],
      ['Repricing schedule', 'Trigger metrics and calendar dates agreed in writing now: if showings fall below X by day 21, we do Y.'],
      ['Seller net sheet', 'Gross price less commission, transfer taxes, flip tax, attorney, and mortgage payoff, at three price points.'],
    ],
    metrics: ['Adjusted $/SF', 'List-to-sale ratio', 'Median DOM', 'Months of supply', 'Showings/week', 'Showing-to-offer ratio', 'Net to seller'],
    watch: 'Never present a single number. Present a range, the reserve, and the cost of being wrong on the high side — the stale-listing discount is larger than the overpricing upside almost every time.',
    dataRequirements: ['inbox', 'acris', 'pluto', 'streeteasy'],
  },
  {
    code: 'P-02', disc: 'P', id: 'price-adjustment-memo',
    name: 'Price Adjustment Memo',
    forWhom: 'Seller / owner', cadence: 'Triggered · day 21 / 45 / 60', role: 'Broker · Agent',
    purpose: 'Make a repricing decision on evidence rather than on fatigue, and give the seller three modeled options instead of one uncomfortable recommendation.',
    sections: [
      ['Performance since launch', 'Days live, activity by week, and where the listing sits against the targets set in the launch plan.'],
      ['Traffic funnel', 'Impressions to saves to inquiries to showings to second showings to offers. Name which step is leaking — a saves problem is a price problem, a showings-with-no-offers problem is usually condition or layout.'],
      ['Feedback themes', 'Verbatim comments coded into categories, with counts. Three people saying the same thing is data.'],
      ['Competitive set movement', 'New supply added, competitor price cuts, and anything that closed in the set since launch.'],
      ['Options modeled', 'Hold, trim, or reset — each with expected time to contract and expected net to seller. Show the carrying cost of holding.'],
      ['Recommendation', 'One recommendation, the reasoning in three sentences, and the next review date.'],
    ],
    metrics: ['DOM vs. neighborhood median', 'Weekly showings trend', 'Saves-to-showing ratio', '$/SF vs. active set', 'Days since last adjustment', 'Carry cost per month'],
    watch: "A cut that doesn't cross a portal search threshold buys almost nothing. Price to land inside the next filter band, or don't cut yet.",
    dataRequirements: ['inbox', 'streeteasy'],
  },
  {
    code: 'P-03', disc: 'P', id: 'new-dev-price-schedule',
    name: 'New Development Unit Price Schedule',
    forWhom: 'Partner · Lender · Sales team', cadence: 'At launch, revised per tranche', role: 'Development manager',
    purpose: 'Set a whole-building price matrix and release strategy so units are priced by rule, not negotiated one at a time by whoever is on floor duty.',
    sections: [
      ['Base $/SF by line', 'The reference price for each stack before any premium. Anchor to the closest comparable new development, adjusted for finish level.'],
      ['Floor premium curve', 'Dollars per floor, usually stepped rather than linear — the jump above the podium and above the neighboring roofline is worth more than the floors between.'],
      ['View, exposure and light adjustments', 'Per-unit adjustment with the reasoning recorded, including which views are protected by zoning and which are not.'],
      ['Outdoor space valuation', 'Terrace, balcony, and garden valued as a percentage of interior $/SF, stated as policy so it is applied consistently.'],
      ['Layout efficiency factor', 'Adjustment for wasted circulation, awkward columns, or unusable bedroom widths.'],
      ['Release schedule', 'Tranche number, unit count, target price, and the absorption trigger that unlocks the next tranche and its escalation percentage.'],
      ['Concession policy', 'Closing cost credits, common charge and tax abatement periods, and the $/SF each is worth. Written as a policy with an approval threshold.'],
      ['Gross vs. net effective schedule', 'Two columns for every unit. Net effective is what you actually sold it for.'],
      ['Sell-out reconciliation', 'Total schedule against the underwritten sell-out, with the gap stated plainly.'],
    ],
    metrics: ['Blended gross $/SF', 'Blended net effective $/SF', 'Total sell-out', 'Premium curve slope', 'Concession load %', 'Tranche escalation %'],
    watch: "Track net effective separately and religiously. Concessions are price cuts that don't appear in the comps, and the next building's underwriting will believe your gross number.",
    dataRequirements: ['inbox', 'pluto'],
  },
  {
    code: 'P-04', disc: 'P', id: 'absorption-velocity',
    name: 'Absorption & Velocity Analysis',
    forWhom: 'Partner · Lender', cadence: 'Monthly during sell-out', role: 'Development manager',
    purpose: "Show whether the sell-out is on pace to clear the loan's minimum-sales covenant before the outside maturity date, and what to change if it isn't.",
    sections: [
      ['Contracts vs. underwritten pace', 'Signed contracts by week and month against the pace in the pro forma, cumulative and period.'],
      ['Inventory remaining', 'By line, by price band, and by unit type. Identify which slice is not moving.'],
      ['Conversion funnel', 'Appointments to second visits to contracts, with average days at each step.'],
      ['Price achieved vs. schedule', 'Actual contract $/SF against the tranche schedule, gross and net effective.'],
      ['Carry cost of delay', 'Debt service, insurance, taxes, and common charges per month of extended sell-out.'],
      ['Forecast to sell-out', 'Three paces — current, underwritten, and downside — each with a projected completion date.'],
      ['Covenant position', "Where the forecast sits against the loan's sales covenant and outside date."],
      ['Recommended actions', 'Price, product, or promotion. One of the three, with the expected effect.'],
    ],
    metrics: ['Contracts/month', 'Absorption %', 'Days appointment-to-contract', 'Achieved vs. scheduled $/SF', 'Months of remaining inventory', 'Carry per unsold unit/month'],
    watch: 'Tie every forecast to the loan covenant date. Absorption that looks fine in the abstract can still be a default.',
    dataRequirements: ['inbox', 'streeteasy'],
  },
  {
    code: 'P-05', disc: 'P', id: 'rental-pricing-rent-roll',
    name: 'Rental Pricing & Rent Roll Analysis',
    forWhom: 'Owner · Partner', cadence: 'Quarterly · at lease-up', role: 'Manager',
    purpose: 'Set asking rents and a concession policy that maximize net effective rent and speed to stabilization, not headline rent.',
    sections: [
      ['Rent roll snapshot', 'Unit, type, SF, in-place rent, lease expiry, regulatory status, and any preferential rent arrangement.'],
      ['Comparable rents', 'By line and unit type, gross and net effective, from signed leases rather than asks.'],
      ['Gross vs. net effective', 'Concessions amortized across the lease term, shown per unit.'],
      ['Vacancy and downtime cost', 'Dollars lost per vacant unit per month, used to justify pricing to fill rather than pricing to hold out.'],
      ['Renewal vs. re-lease economics', 'Cost of turnover — downtime, paint, broker fee — against the rent increase a re-lease would achieve.'],
      ['Expiration ladder', 'Lease expirations by month, flagging any month with too many at once.'],
      ['Recommended asks', 'By unit type, with the concession policy and an approval threshold for exceptions.'],
    ],
    metrics: ['Net effective $/SF/mo', 'Gross-to-net spread', 'Vacancy %', 'Avg. days vacant', 'Renewal rate', 'Loss to lease'],
    watch: 'Concessions compound into the exit valuation. Model what the stabilized NOI looks like on net effective rents at the exit cap, not on gross.',
    dataRequirements: ['inbox', 'streeteasy'],
  },

  // ── U — UNDERWRITING ─────────────────────────────────────────────────────
  {
    code: 'U-01', disc: 'U', id: 'acquisition-screening',
    name: 'Acquisition Screening Memo',
    forWhom: 'Internal · Capital partner', cadence: 'Per opportunity', role: 'Principal',
    purpose: 'Kill or advance a deal in one page, so real underwriting time only gets spent on deals that survive the two questions that actually decide them.',
    sections: [
      ['Property snapshot', 'Address, lot, existing improvements, current use, seller motivation, and how the deal came to you.'],
      ['Price basis', 'Asking price expressed as $/SF of existing and $/buildable SF, against recent land and building trades.'],
      ['Zoning summary', 'District, FAR, height and setback controls, permitted use, overlays, and any inclusionary or special district requirement.'],
      ['Buildable analysis', 'As-of-right buildable SF versus existing, plus available air rights and their likely cost.'],
      ['Residual land value', 'Back into what the land is worth from a rough revenue assumption and a three-line budget.'],
      ['Go / no-go', 'The two questions that decide this deal, and who can answer them within a week.'],
    ],
    metrics: ['$/buildable SF', 'Residual land value', 'Untrended yield on cost', 'Spread to exit cap', 'Equity required', 'Time to answer the open questions'],
    watch: 'One page. If it needs more than one page it has already passed screening — move it to a full underwrite or drop it.',
    dataRequirements: ['acris', 'pluto'],
  },
  {
    code: 'U-02', disc: 'U', id: 'development-pro-forma',
    name: 'Development Pro Forma Summary',
    forWhom: 'Capital partner · Lender · IC', cadence: 'Per deal, revised at each milestone', role: 'Principal',
    purpose: "Present the deal's economics with every assumption sourced, so the conversation is about the assumptions rather than about the spreadsheet.",
    sections: [
      ['Sources and uses', "Full capitalization with each source's cost, term, and conditions."],
      ['Hard costs', 'By trade with $/SF, against a benchmark set. Flag the three largest lines and where the estimate came from.'],
      ['Soft costs', 'Design, filings, legal, insurance, marketing, and developer fee, with the schedule of when each is incurred.'],
      ['Carry and financing', 'Interest reserve, origination, exit fees, and carry during sell-out or lease-up.'],
      ['Revenue schedule', 'Unit by unit or by type, gross and net effective, tied to the price schedule.'],
      ['Timeline', 'Milestones from closing through permit, foundation, topping out, TCO, and sell-out, with the critical path named.'],
      ['Sensitivity grid', 'Cost, revenue, and timeline each moved plus and minus, with returns at each corner.'],
      ['Returns', 'Levered and unlevered IRR, equity multiple, profit, yield on cost, and spread to exit cap.'],
      ['Assumption register', 'Every material assumption with its source and a confidence flag. This is the section people actually read twice.'],
    ],
    metrics: ['Yield on cost', 'Spread to exit cap (bps)', 'Levered IRR', 'Equity multiple', 'Profit on cost %', 'Peak equity', 'Break-even $/SF'],
    watch: 'Unsourced assumptions are the ones that break the deal. If a number has no named source, it goes in the register flagged red until it does.',
    dataRequirements: ['pluto', 'acris'],
  },
  {
    code: 'U-03', disc: 'U', id: 'investment-committee-memo',
    name: 'Investment Committee Memo',
    forWhom: 'Capital partner · IC', cadence: 'Per deal', role: 'Principal',
    purpose: 'Ask for a specific decision on a specific amount by a specific date, with the downside case in the body where it belongs.',
    sections: [
      ['Recommendation and ask', 'The dollar amount, the timing, and the decision being requested. First paragraph, no preamble.'],
      ["Deal summary", "What it is, what you'd build, what you'd sell or hold, and over what period."],
      ['Roles and economics', 'Who does what, who guarantees what, and how the sponsor is compensated at each layer.'],
      ['Market thesis', 'The demand argument with evidence, and the specific comparable set that supports the revenue assumption.'],
      ['Underwriting summary', 'Base case and downside case side by side, with the trigger that would move you from one to the other.'],
      ['Capital stack and waterfall', 'Debt terms, equity structure, preferred return, tiers, and promote — with a worked distribution example.'],
      ['Risk register', 'Each risk, its mitigant, and the named person who owns it.'],
      ['Entitlement and permit status', 'What is filed, what is approved, and what remains, with realistic dates.'],
      ['Exit strategy', 'Primary exit, alternate exit, and the hold period each implies.'],
      ['Conditions to closing', 'What must be true before capital is called.'],
    ],
    metrics: ['Total capitalization', 'LP / GP split', 'Preferred return', 'Promote structure', 'DSCR', 'LTC and LTV', 'Downside IRR'],
    watch: 'The downside case belongs in the body, not the appendix. Committees that find it in the appendix stop trusting the base case.',
    dataRequirements: ['pluto', 'acris'],
  },
  {
    code: 'U-04', disc: 'U', id: 'highest-best-use',
    name: 'Highest & Best Use Study',
    forWhom: 'Internal · Capital partner', cadence: 'Pre-acquisition', role: 'Principal',
    purpose: 'Test what the site should become before committing to what you assumed it would become.',
    sections: [
      ['Site and zoning envelope', 'Lot dimensions, district controls, FAR by use, height and setback, and any landmark or special district constraint.'],
      ['Legally permissible uses', 'What the zoning allows as of right, and what would require a variance, special permit, or rezoning.'],
      ['Physically possible massing', 'Two to four massing options with buildable SF, efficiency ratio, and unit counts.'],
      ['Financial feasibility per option', 'Residual land value and yield on cost for each option under a consistent set of assumptions.'],
      ['Entitlement path and probability', 'For any option requiring approvals: process, timeline, cost, and an honest probability.'],
      ['Scenario comparison', 'One table, all options, same columns.'],
      ['Conclusion', 'The maximally productive use, and the condition under which the answer would change.'],
    ],
    metrics: ['Buildable SF by scenario', 'Residual land value', 'Yield on cost', 'Months to CO', 'Entitlement risk rating', 'Efficiency ratio'],
    watch: 'Run the as-of-right scenario properly even when the upzoning story is exciting. As-of-right is the floor you can actually finance.',
    dataRequirements: ['pluto'],
  },

  // ── M — MARKETING ────────────────────────────────────────────────────────
  {
    code: 'M-01', disc: 'M', id: 'seller-activity',
    name: 'Seller Activity Report',
    forWhom: 'Seller / owner', cadence: 'Weekly', role: 'Broker · Agent',
    purpose: 'Show the seller what happened, what it means, and whether they need to decide anything — so silence never gets interpreted as inactivity.',
    sections: [
      ['Week at a glance', 'Three lines: traffic, feedback, and where we stand against plan.'],
      ['Marketing performed', "What ran, where, and what it cost or was worth. Specific, not 'continued marketing efforts'."],
      ['Traffic metrics', 'Views, saves, inquiries, showings, second showings, offers — this week, last week, and cumulative.'],
      ['Feedback', 'Verbatim comments, then the same comments coded into themes with counts.'],
      ['Competitive set movement', 'What listed, what cut, what closed in the direct competition this week.'],
      ['Objections and responses', 'The objections raised and how they were handled, so the seller sees the work.'],
      ["Next week's plan", 'Specific actions with dates.'],
      ['Decision needed', 'Either one specific decision with a deadline, or the words: no action needed this week.'],
    ],
    metrics: ['Listing views', 'Saves', 'Inquiries', 'Showings', 'Second showings', 'Offers', 'DOM'],
    watch: "End every report with either a specific decision or an explicit 'no action needed.' A vague nudge trains sellers to skim.",
    dataRequirements: ['inbox', 'streeteasy'],
  },
  {
    code: 'M-02', disc: 'M', id: 'buyer-match',
    name: 'Buyer Match & Search Report',
    forWhom: 'Buyer client', cadence: 'Weekly', role: 'Broker · Agent',
    purpose: 'Keep a buyer oriented in a moving market and surface the gap between their criteria and what their budget actually buys, early.',
    sections: [
      ['Criteria of record', 'The current brief, and any change made since last week, restated so drift is visible.'],
      ['Matching inventory', 'How many active listings meet the criteria right now, and how that count has moved.'],
      ['Curated matches', 'Each with the fit rationale in one sentence and the dealbreaker in one sentence.'],
      ['Near misses', 'What was close and why it was excluded — this is where criteria get usefully revised.'],
      ['Off-market and pre-market', 'Whisper listings, expected launches, and anything sourced through broker relationships.'],
      ['Budget reality check', "Median and range of $/SF within the criteria against the buyer's number, including monthlies."],
      ['Showing schedule', 'Confirmed and proposed.'],
      ["Recommended adjustment", "If the criteria don't clear inventory, say which constraint to relax and what it would open up."],
    ],
    metrics: ['Matches this period', 'Inventory in criteria', 'Median $/SF in criteria', 'Budget gap', 'Weeks of supply at current pace', 'Showings completed'],
    watch: 'If the same criterion excludes everything for three weeks running, that is the report. Lead with it.',
    dataRequirements: ['inbox'],
  },
  {
    code: 'M-03', disc: 'M', id: 'listing-launch-plan',
    name: 'Listing Launch Plan',
    forWhom: 'Seller / owner · Internal', cadence: 'Per listing, pre-launch', role: 'Broker · Agent',
    purpose: 'Get everything finished before the listing goes live, because week one traffic is the only free traffic a listing ever gets.',
    sections: [
      ['Positioning', 'Who the buyer is, what they are comparing this to, and the one sentence the listing has to land.'],
      ['Pricing', 'Carried in from the CMA: ask, reserve, and the repricing triggers.'],
      ['Preparation scope', 'Paint, repairs, decluttering, staging — with cost, vendor, and completion date each.'],
      ['Media schedule', 'Photography, floor plan, video, and any virtual staging, with shoot date and delivery date.'],
      ['Copy and hero image', 'Final headline, description, and the image that leads. Approved before launch, not during.'],
      ['Syndication plan', 'Portals, feeds, firm site, and the timing of each so nothing goes live early.'],
      ['Broker outreach', 'Target agent list, preview timing, and co-broke terms.'],
      ['Open house calendar', 'First three weekends, with staffing.'],
      ['Week one and two targets', 'The numbers that will define whether the launch worked.'],
      ['Go-live checklist', 'Everything that must be complete. No partial launches.'],
    ],
    metrics: ['Days to launch', 'Prep budget vs. actual', 'Target week-1 showings', 'Target week-2 offers', 'Media delivery date'],
    watch: 'Do not go live until photos, floor plan, and copy are all final. A relaunch costs far more than a two-week delay.',
    dataRequirements: ['inbox'],
  },
  {
    code: 'M-04', disc: 'M', id: 'offer-comparison',
    name: 'Offer Comparison & Bid Analysis',
    forWhom: 'Seller / owner', cadence: 'Per offer round', role: 'Broker · Agent',
    purpose: 'Rank offers by probability-weighted net to seller and closing certainty, rather than by the headline number.',
    sections: [
      ['Offer grid', 'Price, deposit, financing type, contingencies, closing date, escalation clause, and any board or approval exposure — one row per bidder.'],
      ['Financial strength', 'Liquid assets after closing, income, debt ratios, and pre-approval quality. For co-ops, the specific board thresholds.'],
      ['Net to seller by offer', 'After commission, transfer taxes, flip tax, and any concession — the number that actually differs between offers.'],
      ['Risk scoring', 'Financing risk, appraisal gap risk, board risk, and timeline risk, each scored and explained.'],
      ['Probability-weighted net', 'Net to seller multiplied by estimated probability of closing.'],
      ['Counter strategy', 'What to ask each bidder for, in what order.'],
      ['Best and final process', 'The deadline, the instructions, and what will be disclosed to whom.'],
    ],
    metrics: ['Net to seller', 'Probability-weighted net', 'Deposit %', 'LTV', 'Post-close liquidity', 'Debt-to-income (board)', 'Days to close'],
    watch: 'The highest offer and the best offer are different documents. Show the seller both numbers next to each other and let the ranking make the argument.',
    dataRequirements: ['inbox'],
  },

  // ── C — CONSTRUCTION ─────────────────────────────────────────────────────
  {
    code: 'C-01', disc: 'C', id: 'monthly-project-status',
    name: 'Monthly Project Status Report',
    forWhom: 'Partner · Lender · Investors', cadence: 'Monthly', role: 'Development manager',
    purpose: 'Give everyone the same picture of schedule, budget, and risk in a form that is comparable month over month.',
    sections: [
      ['Executive summary', 'Three lines — schedule, budget, risk — each with a direction and a color.'],
      ['Schedule status', 'Progress against baseline, current critical path, float remaining, and forecast completion date.'],
      ['Budget status', 'Committed, spent, remaining, and forecast at completion by major category.'],
      ['Change orders this period', 'Number, value, cause, and schedule impact.'],
      ['Contingency ledger', 'Starting, drawn to date, committed, and remaining as a percentage of remaining work.'],
      ['Approvals and inspections', 'DOB filings, special inspections, sign-offs, and the path to TCO with dates.'],
      ['Site log', 'Manpower, safety incidents, weather days, and deliveries of long-lead items.'],
      ['Decisions required', 'Each with the decision, the owner, and the date it becomes a schedule problem.'],
      ['Photos', 'Dated, from the same vantage points each month.'],
      ['Next period milestones', 'What should be true by the next report.'],
    ],
    metrics: ['% complete', 'Schedule variance (days)', 'Forecast at completion', 'Contingency remaining %', 'Change orders this period', 'Days to TCO'],
    watch: 'Report forecast at completion, not just spent to date. Spend tells you the past; the forecast is what the lender is actually asking about.',
    dataRequirements: ['dob'],
  },
  {
    code: 'C-02', disc: 'C', id: 'draw-request-summary',
    name: 'Draw Request Summary',
    forWhom: 'Lender · Partner', cadence: 'Monthly', role: 'Development manager',
    purpose: "Package a requisition so it funds on the first pass, by anticipating the lender's exceptions before they raise them.",
    sections: [
      ['Draw identification', 'Draw number, period covered, and requested amount.'],
      ['Requisition by cost code', 'This draw, cumulative, and remaining, against the approved budget.'],
      ['Percent complete by line', 'This draw versus the prior draw, with the basis for each judgment.'],
      ['Lien waivers', 'Received, outstanding, conditional versus unconditional, by subcontractor.'],
      ['Certifications', 'Architect and inspecting engineer sign-offs, and title continuation status.'],
      ['Retainage', 'Held this period and cumulative, by trade.'],
      ['Stored materials', 'Location, insurance, and bill of sale, if any are included.'],
      ['Funding sequence', 'Equity versus debt applied this draw and remaining balance of each.'],
      ['Anticipated exceptions', 'Anything unusual, explained before the lender asks.'],
    ],
    metrics: ['Draw amount', 'Cumulative funded', '% of loan drawn', 'Retainage held', 'Remaining contingency', 'Avg. days submission to funding'],
    watch: "Track your trailing average from submission to funding. If it's growing, the package is the problem, not the lender.",
    dataRequirements: ['dob'],
  },
  {
    code: 'C-03', disc: 'C', id: 'change-order-log',
    name: 'Change Order & Contingency Log',
    forWhom: 'Partner · Lender', cadence: 'Monthly', role: 'Development manager',
    purpose: 'Make the pattern in change orders visible, because the cause distribution predicts the rest of the job better than the running total does.',
    sections: [
      ['Log table', 'Number, date, description, cause code, amount, schedule impact, status, approver, date approved.'],
      ['Cause analysis', 'Grouped by design gap, field condition, owner request, agency or code, and escalation — with the value in each bucket.'],
      ['Contingency ledger', 'Starting, drawn, committed but not drawn, and remaining against remaining work.'],
      ['Forward exposure', 'Known unpriced items and an estimate of what remains likely.'],
      ['Recovery actions', 'Value engineering, resequencing, or scope trades under consideration.'],
    ],
    metrics: ['Total CO value', 'CO as % of hard cost', 'Contingency remaining %', 'Avg. days to approval', 'Cumulative schedule impact'],
    watch: 'If design-gap changes dominate the log at 30% complete, the drawings are the problem and the number will keep growing. Say so early.',
    dataRequirements: ['dob'],
  },

  // ── I — INVESTOR ─────────────────────────────────────────────────────────
  {
    code: 'I-01', disc: 'I', id: 'quarterly-lp-update',
    name: 'Quarterly LP Update',
    forWhom: 'Limited partners', cadence: 'Quarterly', role: 'Principal',
    purpose: 'Build the reporting habit that makes the second and third deals easier to raise, by explaining variance every quarter rather than only in good ones.',
    sections: [
      ['Headline', 'One paragraph a busy investor could read alone and know where things stand.'],
      ['Project progress', 'What was completed this quarter, with dated photos.'],
      ['Financial summary', 'Budget versus actual, sources drawn, and remaining capitalization.'],
      ['Sales or leasing progress', 'Contracts, closings, or leases signed against the plan.'],
      ['Distributions', 'This quarter and cumulative, with the calculation shown.'],
      ['Capital account', 'Per member: contributed, distributed, unreturned capital, and accrued preferred return.'],
      ['Projection vs. original underwriting', 'Current projected IRR and multiple against the original, with the variance explained.'],
      ['Risks and mitigants', 'The two or three that actually matter, with what you are doing about each.'],
      ['Upcoming milestones', 'Including any expected capital event or call.'],
      ['Questions', 'How and when to reach you.'],
    ],
    metrics: ['Capital contributed', 'Distributions to date', 'Unreturned capital', 'Accrued preferred', 'Projected IRR vs. original', '% complete'],
    watch: "Explain variance from the original projection every single quarter, including when it's favorable. Silence in good quarters makes the bad quarter look like a surprise.",
    dataRequirements: ['inbox'],
  },
  {
    code: 'I-02', disc: 'I', id: 'capital-call-notice',
    name: 'Capital Call Notice',
    forWhom: 'Limited partners', cadence: 'As required', role: 'Principal',
    purpose: 'Give clean, unambiguous notice that satisfies the operating agreement and gets funds wired on time.',
    sections: [
      ['Notice details', 'Notice date, funding deadline, and the required notice period under the operating agreement.'],
      ['Amount called', 'Total, and per member with the pro rata calculation shown.'],
      ['Use of proceeds', 'What the capital funds, by line.'],
      ['Funding instructions', 'Wire details, reference format, and confirmation process — with a callback verification step stated.'],
      ['Governing provision', 'The operating agreement section under which the call is made.'],
      ['Failure to fund', 'The consequence under the agreement — dilution, default interest, or otherwise — stated plainly.'],
      ['Contact', 'Who to call with questions, and by when.'],
      ['Acknowledgment', 'Signature or confirmation of receipt.'],
    ],
    metrics: ['Total call', 'Per-member amount', '% of total commitment', 'Remaining unfunded commitment', 'Days notice given', 'Funding deadline'],
    watch: 'This is a legal notice, not a report. Have counsel review the form once against your operating agreement — the notice period and dilution language especially — then reuse it unchanged. Always verify wire instructions by phone on a known number.',
    dataRequirements: ['inbox'],
  },
  {
    code: 'I-03', disc: 'I', id: 'disposition-closeout',
    name: 'Disposition & Closeout Report',
    forWhom: 'Limited partners · Internal', cadence: 'At exit', role: 'Principal',
    purpose: 'Close the deal properly and produce the track record document you will show to the next set of investors.',
    sections: [
      ['Transaction summary', 'Buyer, price, closing date, and how the exit was executed.'],
      ['Final sources and uses', 'The complete capitalization as it actually happened.'],
      ['Actual vs. underwritten', 'Revenue, cost, timeline, and returns side by side, with the variance on each explained.'],
      ['Waterfall calculation', 'Every tier worked through, with the arithmetic visible.'],
      ['Distribution schedule', 'Amount and date per member.'],
      ['Promote calculation', 'Shown step by step. This is the number investors check most carefully.'],
      ['Final capital accounts', 'Per member, reconciled.'],
      ['Tax reporting', 'K-1 timeline, expected character of income, and the accountant contact.'],
      ['Lessons learned', 'What you would underwrite differently. Include this — it is the section that earns the next commitment.'],
      ['Entity wind-down', 'Final filings, insurance tail, records retention, and dissolution steps.'],
    ],
    metrics: ['Gross proceeds', 'Net proceeds', 'Total profit', 'LP IRR and multiple', 'GP promote earned', 'Hold period', 'Variance to projection'],
    watch: 'Show the promote arithmetic in full. Anything summarized invites the question you least want to answer by email six months later.',
    dataRequirements: ['inbox', 'acris'],
  },

  // ── O — OPERATIONS ───────────────────────────────────────────────────────
  {
    code: 'O-01', disc: 'O', id: 'team-pipeline-production',
    name: 'Team Pipeline & Production Report',
    forWhom: 'Internal · Management', cadence: 'Weekly or monthly', role: 'Manager',
    purpose: 'Forecast revenue from pipeline stages rather than from optimism, and surface the listings that need intervention before they expire.',
    sections: [
      ['Production summary', 'Closed, pending, and active by agent, with units and volume.'],
      ['Pipeline by stage', 'Count and value at each stage with expected close month.'],
      ['Weighted forecast', 'Pipeline value multiplied by historical conversion rate at each stage.'],
      ['New business by channel', 'Sphere, referral, portal, open house, farming — with cost per acquisition where known.'],
      ['Listing inventory health', 'DOM distribution, listings past their repricing trigger, and expirations inside 60 days.'],
      ['Conversion analysis', 'Where deals are falling out, by stage and by agent.'],
      ['Accountability items', 'Named, dated, and carried forward until closed.'],
    ],
    metrics: ['GCI closed / pending', 'Units', 'Avg. sale price', 'Weighted pipeline value', 'Stage conversion rates', 'Listings expiring in 60 days'],
    watch: "Weight the pipeline by actual historical conversion, not by the agent's confidence. The two numbers diverge in a predictable direction.",
    dataRequirements: ['inbox'],
  },
  {
    code: 'O-02', disc: 'O', id: 'market-snapshot',
    name: 'Market Snapshot',
    forWhom: 'Clients · Prospects · Internal', cadence: 'Quarterly', role: 'Broker · Agent · Manager',
    purpose: 'Publish a consistent quarterly read that builds authority and gives every client conversation a shared factual starting point.',
    sections: [
      ['Headline read', 'What actually happened this quarter, in one paragraph, with a point of view.'],
      ['Closed sales', 'Volume, units, median and average price by property type, with year-over-year change.'],
      ['Price per square foot', 'Trend by property type over eight quarters, so seasonality is visible.'],
      ['Inventory and supply', 'Active listings, new listings, and months of supply.'],
      ['Days on market and negotiability', 'DOM and list-to-sale ratio, which together describe leverage better than price does.'],
      ['New development vs. resale', 'Split of closings and pricing, since blending them distorts the median.'],
      ['Rental market', 'Median rent, net effective spread, and vacancy.'],
      ['Rate environment', 'Where mortgage rates sit and what that does to the qualifying buyer pool at each price band.'],
      ['What it means', 'Separate short sections for sellers and for buyers.'],
      ['Outlook', 'Two or three things you are watching next quarter.'],
    ],
    metrics: ['Closed units', 'Median price', 'Avg. $/SF', 'Months of supply', 'Median DOM', 'List-to-sale ratio', 'YoY change on each'],
    watch: "Use the same definitions and the same geography every quarter. A snapshot's value is entirely in its comparability.",
    dataRequirements: ['inbox', 'streeteasy', 'fred', 'acris'],
  },
]

function buildTemplate(raw: RawSheet): ReportTemplate {
  const overrideKeys = SECTION_KEY_OVERRIDES[raw.code]
  const sections: ReportSection[] = raw.sections.map(([title, description], i) => ({
    key: overrideKeys ? overrideKeys[i] : kebab(title),
    title,
    description,
  }))
  const isUnlocked =
    HAS_GENERATOR.has(raw.id) && raw.dataRequirements.every(d => AVAILABLE_SOURCES.has(d))
  return {
    id: raw.id,
    code: raw.code,
    discipline: raw.disc,
    disciplineName: DISCIPLINE_NAMES[raw.disc],
    name: raw.name,
    forWhom: raw.forWhom,
    cadence: raw.cadence,
    role: raw.role,
    purpose: raw.purpose,
    sections,
    metrics: raw.metrics,
    watch: raw.watch,
    dataRequirements: raw.dataRequirements,
    isUnlocked,
  }
}

export const REPORT_TEMPLATES: ReportTemplate[] = RAW_SHEETS.map(buildTemplate)

export function getTemplate(id: string): ReportTemplate | undefined {
  return REPORT_TEMPLATES.find(t => t.id === id)
}

export function getTemplatesByDiscipline(d: string): ReportTemplate[] {
  return REPORT_TEMPLATES.filter(t => t.discipline === d)
}
