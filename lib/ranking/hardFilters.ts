// Brief 33 — hard exclusion filters, applied BEFORE feature scoring. A contact
// hitting any filter is dropped from the queue entirely. First hit wins; the
// reason is returned for observability (exclusion counts).
export interface HardFilterInput {
  status: string | null
  tags: string[]
  groups: string[]
  phones: (string | null)[] // [primary, ...additional]
  phoneDncFlags: boolean[]
  matchCount: number
  allMatchesRental: boolean
}

const STATUS_DNC = ['do_not_call', 'do not call', 'dnc', 'opt-out', 'opted out']
const TAG_DNC = ['do_not_call', 'dnc', 'opt-out', 'opted_out']

export function applyHardFilters(input: HardFilterInput): { excluded: boolean; reason?: string } {
  // 1. status field
  const status = input.status?.toLowerCase() ?? ''
  if (STATUS_DNC.some(s => status.includes(s))) return { excluded: true, reason: 'status_do_not_call' }

  // 2. tags / groups opt-out (case-insensitive membership)
  const tagset = [...input.tags, ...input.groups].map(t => t.toLowerCase())
  if (tagset.some(t => TAG_DNC.includes(t))) return { excluded: true, reason: 'tag_or_group_opt_out' }

  // 3. every known phone is DNC (missing flags treated as false → not excluded)
  const realPhones = input.phones.filter((p): p is string => p != null)
  if (realPhones.length > 0) {
    const allDnc = input.phones.every((p, i) => p == null || (input.phoneDncFlags[i] ?? false))
    if (allDnc) return { excluded: true, reason: 'all_phones_dnc' }
  }

  // 4. no matches at all
  if (input.matchCount === 0) return { excluded: true, reason: 'no_matches' }

  // 5. rentals only (defensive — the scorer already rejects rentals)
  if (input.allMatchesRental) return { excluded: true, reason: 'only_rental_matches' }

  return { excluded: false }
}
