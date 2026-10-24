// Brief 27.0 — Report Engine template catalog (Phase 1a).
//
// The report descriptors, transcribed from the standard-issue report library
// (the SHEETS array in report-template-library.html). This is the model- and
// UI-facing source of truth for what a report IS: its purpose, its sections,
// its metrics, and what data it needs to be generatable.
//
// Brief 48 PR 19 [Ryan 1.11]: the catalog is the one report that works, M-02
// (Buyer Match & Search): it needs inbox data only, has a working generator
// (lib/reports/generators/buyer-match), and Drift uses it. The library's other
// 20 sheets were locked (no generator) and are removed. A template still needs
// a generator (HAS_GENERATOR) and its data to be made; a future brief adds
// both, and its sheet here.

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

// Brief 48 PR 19 [Ryan 1.11]: only the Buyer Match report. The other 20 sheets
// of the library (P-01 to P-05, U-01 to U-04, M-01, M-03, M-04, C-01 to C-03,
// I-01 to I-03, O-01, O-02) had no generator, so they could never be made, and
// were removed, the Seller Activity report (M-01) among them. They are code,
// not database rows; every saved report is a Buyer Match report.
const RAW_SHEETS: RawSheet[] = [
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
