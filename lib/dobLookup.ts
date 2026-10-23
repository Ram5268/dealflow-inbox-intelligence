// NYC DOB data via NYC Open Data (free, no API key needed for low volume)
import { fetchWithTimeout } from './chat/turnBudget'

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
  permits: DobPermit[]
  violations: DobViolation[]
  summary: string
}

function parseHouseAndStreet(address: string): { houseNo: string; streetName: string; boro: string } | null {
  // Extract house number and street name from addresses like "123 Main St, Brooklyn, NY"
  const match = address.match(/^(\d+[-\d]*)\s+(.+?)(?:,|$)/)
  if (!match) return null
  const houseNo = match[1]
  let streetName = match[2].trim().toUpperCase()
  // Remove unit/apt info
  streetName = streetName.replace(/\s+(APT|UNIT|#|SUITE|FL|FLOOR|PH|PHC|STE)\s*.*$/i, '').trim()

  // Detect borough
  const lower = address.toLowerCase()
  let boro = 'MANHATTAN'
  if (lower.includes('brooklyn') || lower.includes('bk')) boro = 'BROOKLYN'
  else if (lower.includes('queens') || lower.includes('astoria') || lower.includes('flushing') ||
           lower.includes('long island city') || lower.includes('jackson heights')) boro = 'QUEENS'
  else if (lower.includes('bronx')) boro = 'BRONX'
  else if (lower.includes('staten island')) boro = 'STATEN ISLAND'

  return { houseNo, streetName, boro }
}

export async function lookupDOB(address: string): Promise<DobResult | null> {
  const parsed = parseHouseAndStreet(address)
  if (!parsed) return null

  const { houseNo, streetName, boro } = parsed

  const streetPrefix = streetName.split(' ')[0]

  try {
    // Socrata rejects raw spaces in the $where clause with HTTP 400, so the entire
    // clause value must be URL-encoded. URLSearchParams encodes each value exactly
    // once ($where and $order), avoiding both the 400 and any double-encoding.
    // Permits (ipu4-2q9a) use house__/street_name; violations (3h2n-5cm9) use
    // house_number/street — different column names per dataset.
    const permitParams = new URLSearchParams({
      $where: `house__='${houseNo}' AND street_name like '${streetPrefix}%'`,
      $limit: '10',
      $order: 'filing_date DESC',
    })
    const violationParams = new URLSearchParams({
      $where: `house_number='${houseNo}' AND street like '${streetPrefix}%'`,
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

    const permits: DobPermit[] = permitsRes?.ok ? await permitsRes.json().catch(() => []) : []
    const violations: DobViolation[] = violationsRes?.ok ? await violationsRes.json().catch(() => []) : []

    if (permits.length === 0 && violations.length === 0) return null

    const lines: string[] = [`DOB RECORDS — ${address.toUpperCase()}`]

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

    return { address, permits, violations, summary: lines.join('\n') }
  } catch {
    return null
  }
}

export function formatDobForChat(result: DobResult): string {
  return `\n\n${result.summary}`
}
