// NYC DOB data via NYC Open Data (free, no API key needed for low volume)
import { fetchWithTimeout } from './chat/turnBudget'
import { parseAddress, ASSUMED_BOROUGH, type BoroughCode } from './acris'

interface DobPermit {
  job_type: string
  work_type: string
  filing_date: string
  current_status: string
  job_description?: string
  owner_last_name?: string
  owner_first_name?: string
  owner_business_name?: string
}

interface DobViolation {
  issue_date: string
  violation_type: string
  description: string
  disposition_date?: string
  disposition_comments?: string
}

export interface DobResult {
  address: string
  boroughCode: BoroughCode
  permits: DobPermit[]
  violations: DobViolation[]
  summary: string
}

// ─── The query (Brief 43 PR 11, M30) ──────────────────────────────────────────
// The DOB lookup used to match the house number plus the street's first word
// in any borough ("12 West Example Street" matched any West-anything street
// with house 12, in all five). It now asks for that borough and that street,
// spelled the ways the city's data spells it [engineering precaution].

// The permits dataset names the borough; the violations dataset uses its code.
const DOB_BOROUGH: Record<BoroughCode, string> = {
  '1': 'MANHATTAN', '2': 'BRONX', '3': 'BROOKLYN', '4': 'QUEENS', '5': 'STATEN ISLAND',
}

// The full street type, then its usual short form.
const TYPE_FORMS: Record<string, string[]> = {
  STREET: ['STREET', 'ST'], AVENUE: ['AVENUE', 'AVE'], PLACE: ['PLACE', 'PL'], ROAD: ['ROAD', 'RD'],
  BOULEVARD: ['BOULEVARD', 'BLVD'], DRIVE: ['DRIVE', 'DR'], LANE: ['LANE', 'LN'], COURT: ['COURT', 'CT'],
  TERRACE: ['TERRACE', 'TER'], PARKWAY: ['PARKWAY', 'PKWY'], PLAZA: ['PLAZA', 'PLZ'], CIRCLE: ['CIRCLE', 'CIR'],
  SQUARE: ['SQUARE', 'SQ'], HIGHWAY: ['HIGHWAY', 'HWY'], EXPRESSWAY: ['EXPRESSWAY', 'EXPWY'],
}
const COMPASS_FORMS: Record<string, string[]> = {
  EAST: ['EAST', 'E'], WEST: ['WEST', 'W'], NORTH: ['NORTH', 'N'], SOUTH: ['SOUTH', 'S'],
}

// Brief 43 PR 11 review: the DOB data writes numbered streets and avenues with
// digits ("5 AVENUE"), so a typed "Fifth Avenue" also asks for "5 AVENUE" and
// "5TH AVENUE", and a typed "5th Ave" also for "FIFTH AVENUE"
// [engineering precaution].
const SPELLED_ORDINALS: Record<string, string> = {
  FIRST: '1', SECOND: '2', THIRD: '3', FOURTH: '4', FIFTH: '5', SIXTH: '6',
  SEVENTH: '7', EIGHTH: '8', NINTH: '9', TENTH: '10', ELEVENTH: '11', TWELFTH: '12',
}
const SPELLED_BY_NUMBER: Record<string, string> = Object.fromEntries(Object.entries(SPELLED_ORDINALS).map(([w, n]) => [n, w]))

function ordinal(n: string): string {
  const num = parseInt(n, 10)
  if (num % 100 >= 11 && num % 100 <= 13) return `${n}TH`
  return `${n}${num % 10 === 1 ? 'ST' : num % 10 === 2 ? 'ND' : num % 10 === 3 ? 'RD' : 'TH'}`
}

/**
 * The spellings of one normalised street name ("WEST 53 STREET") to match
 * exactly: with and without the ordinal ("53RD"), the compass and the type
 * short or long ("W 53 ST"). Exact matches only, so "WEST 5 STREET" is never
 * "WEST 53 STREET" and "PARK AVENUE" is never "PARK AVENUE SOUTH".
 */
export function dobStreetForms(streetName: string): string[] {
  const words = streetName.split(' ').filter(Boolean)
  const last = words.length - 1
  const choices = words.map((w, i) => {
    if (/^\d+$/.test(w)) return SPELLED_BY_NUMBER[w] && words.length > 1 ? [w, ordinal(w), SPELLED_BY_NUMBER[w]] : [w, ordinal(w)]
    if (SPELLED_ORDINALS[w] && words.length > 1) return [w, SPELLED_ORDINALS[w], ordinal(SPELLED_ORDINALS[w])]
    if (COMPASS_FORMS[w] && words.length > 1 && (i === 0 || i === last)) return COMPASS_FORMS[w]
    const typeHere = i === last || (i === last - 1 && COMPASS_FORMS[words[last]] !== undefined) ||
      (i === 0 && words.length === 2 && /^[A-Z]$/.test(words[1]))          // "AVENUE J"
    if (TYPE_FORMS[w] && typeHere) return TYPE_FORMS[w]
    if (i === 0 && (w === 'ST' || w === 'SAINT') && words.length > 2) return ['ST', 'SAINT']
    return [w]
  })
  let forms = ['']
  for (const options of choices) forms = forms.flatMap(f => options.map(o => (f ? `${f} ${o}` : o)))
  return [...new Set(forms)].slice(0, 48)
}

const soql = (value: string) => `'${value.replace(/'/g, "''")}'`

/** The permits and violations `$where` clauses for one building. */
export function dobWhereClauses(a: { streetNumber: string; streetName: string; boroughCode: BoroughCode }): { permits: string; violations: string } {
  const house = soql(a.streetNumber)
  const streets = dobStreetForms(a.streetName).map(soql).join(',')
  return {
    permits: `house__=${house} AND borough=${soql(DOB_BOROUGH[a.boroughCode])} AND street_name in (${streets})`,
    violations: `house_number=${house} AND boro=${soql(a.boroughCode)} AND street in (${streets})`,
  }
}

// What a permits-and-violations lookup found. 'none' only when both datasets
// answered with nothing ("none on file", DRIFT_SCRIPT #22); 'failed' when
// either didn't answer and nothing came back.
export type DobRecords =
  | { status: 'found'; result: DobResult }
  | { status: 'none'; label: string }
  | { status: 'failed' }

/**
 * Permits and violations for one building. `opts.boroughCode` (a chat lookup
 * always passes one) wins over a borough in the address text; with neither,
 * Brooklyn is assumed (ASSUMED_BOROUGH), never every borough.
 */
export async function findDobRecords(address: string, opts: { boroughCode?: BoroughCode | null } = {}): Promise<DobRecords> {
  const parsed = parseAddress(address)
  if (!parsed || !parsed.streetName) return { status: 'failed' }
  const boroughCode = opts.boroughCode ?? parsed.boroughCode ?? ASSUMED_BOROUGH
  const label = `${parsed.streetNumber} ${parsed.streetName}, ${DOB_BOROUGH[boroughCode]}`
  const where = dobWhereClauses({ streetNumber: parsed.streetNumber, streetName: parsed.streetName, boroughCode })

  try {
    // Socrata rejects raw spaces in the $where clause with HTTP 400, so the entire
    // clause value must be URL-encoded. URLSearchParams encodes each value exactly
    // once ($where and $order), avoiding both the 400 and any double-encoding.
    // Permits (ipu4-2q9a) use house__/street_name/borough; violations (3h2n-5cm9)
    // use house_number/street/boro — different column names per dataset.
    const permitParams = new URLSearchParams({
      $where: where.permits,
      $limit: '10',
      $order: 'filing_date DESC',
    })
    const violationParams = new URLSearchParams({
      $where: where.violations,
      $limit: '5',
      $order: 'issue_date DESC',
    })

    // Brief 43 PR 4 (M32): each fetch gives up after LOOKUP_TIMEOUT_MS
    // (fetchWithTimeout's default) [engineering precaution].
    const [permitsRes, violationsRes] = await Promise.all([
      fetchWithTimeout(
        `https://data.cityofnewyork.us/resource/ipu4-2q9a.json?${permitParams}`,
        { headers: { 'X-App-Token': process.env.SOCRATA_APP_TOKEN ?? '' } }
      ).catch(() => null),
      fetchWithTimeout(
        `https://data.cityofnewyork.us/resource/3h2n-5cm9.json?${violationParams}`,
        { headers: { 'X-App-Token': process.env.SOCRATA_APP_TOKEN ?? '' } }
      ).catch(() => null),
    ])

    // null: that dataset didn't answer.
    const read = async <T>(res: Response | null): Promise<T[] | null> => {
      if (!res?.ok) return null
      const rows = await res.json().catch(() => null)
      return Array.isArray(rows) ? rows as T[] : null
    }
    const permitRows = await read<DobPermit>(permitsRes)
    const violationRows = await read<DobViolation>(violationsRes)
    const permits = permitRows ?? []
    const violations = violationRows ?? []

    if (permits.length === 0 && violations.length === 0) {
      return permitRows && violationRows ? { status: 'none', label } : { status: 'failed' }
    }

    const lines: string[] = [`DOB RECORDS — ${label}`]

    if (permits.length > 0) {
      lines.push(`\nPERMIT ACTIVITY (${permits.length} recent):`)
      permits.slice(0, 5).forEach(p => {
        const date = p.filing_date ? new Date(p.filing_date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '?'
        lines.push(`  ${date} — ${p.job_type ?? ''} ${p.work_type ?? ''}: ${p.job_description ?? ''} [${p.current_status ?? ''}]`)
      })
    }

    if (violations.length > 0) {
      lines.push(`\nVIOLATIONS (${violations.length} recent):`)
      violations.slice(0, 3).forEach(v => {
        const date = v.issue_date ? new Date(v.issue_date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '?'
        lines.push(`  ${date} — ${v.violation_type ?? ''}: ${v.description ?? ''}`)
      })
    }

    // Brief 43 PR 11: one dataset answering doesn't make the other "none".
    if (!permitRows) lines.push('\nPermits are missing here: the city records did not answer.')
    if (!violationRows) lines.push('\nViolations are missing here: the city records did not answer.')

    return { status: 'found', result: { address, boroughCode, permits, violations, summary: lines.join('\n') } }
  } catch {
    return { status: 'failed' }
  }
}

export async function lookupDOB(address: string, opts: { boroughCode?: BoroughCode | null } = {}): Promise<DobResult | null> {
  const found = await findDobRecords(address, opts)
  return found.status === 'found' ? found.result : null
}

export function formatDobForChat(result: DobResult): string {
  return `\n\n${result.summary}`
}
