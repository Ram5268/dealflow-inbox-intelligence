import type { CrmContact } from './mapLead'
import { normalizeStreet } from './addressNormalize'

// Brief 34: decides which existing MojoContact row each CRM lead lands on, so
// the sync never creates a second record for someone who already exists.
//   keeper: the row with the lead's mojoId. Failing that, the one intact csv_*
//           copy (2-letter state, 5-digit ZIP) with the same name and street,
//           re-keyed to the CRM mojoId.
//   every other csv_* row with that name and street becomes a duplicate of the keeper.
// A lead whose csv rows are ambiguous is skipped and reported, never inserted.
export interface ExistingRow {
  id: string
  mojoId: string
  fullName: string
  address: string | null
  state: string | null
  zipCode: string | null
  phone: string | null
  additionalPhones: string[] | null
  email: string | null
  additionalEmails: string[] | null
}

export interface SyncPlan {
  upserts: { contact: CrmContact; keeper: ExistingRow | null }[]
  rekeys: { id: string; old_id: string; new_id: string }[]
  duplicates: { id: string; keeper_id: string }[]
  skipped: { mojoId: string; reason: string; rowIds: string[] }[]
}

const personKey = (name: string | null, street: string | null) =>
  `${(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')}|${normalizeStreet(street) ?? ''}`
const isIntact = (r: ExistingRow) => /^[a-z]{2}$/i.test(r.state ?? '') && /^\d{5}/.test(r.zipCode ?? '')

export function planSync(contacts: CrmContact[], rows: ExistingRow[]): SyncPlan {
  const plan: SyncPlan = { upserts: [], rekeys: [], duplicates: [], skipped: [] }
  const byMojoId = new Map(rows.map(r => [r.mojoId, r]))
  const csvByKey = new Map<string, ExistingRow[]>()
  for (const r of rows.filter(r => r.mojoId.startsWith('csv_'))) {
    const k = personKey(r.fullName, r.address)
    csvByKey.set(k, [...(csvByKey.get(k) ?? []), r])
  }
  const leadsPerKey = new Map<string, number>()
  for (const c of contacts) {
    const k = personKey(c.fullName, c.address)
    leadsPerKey.set(k, (leadsPerKey.get(k) ?? 0) + 1)
  }

  for (const contact of contacts) {
    const k = personKey(contact.fullName, contact.address)
    const csvRows = csvByKey.get(k) ?? []
    const ambiguous = csvRows.length > 0 && (leadsPerKey.get(k) ?? 0) > 1
    const skip = (reason: string) => plan.skipped.push({ mojoId: contact.mojoId, reason, rowIds: csvRows.map(r => r.id) })
    if (ambiguous) skip('csv rows match more than one CRM lead')
    const twins = ambiguous ? [] : csvRows

    let keeper = byMojoId.get(contact.mojoId) ?? null
    if (!keeper && csvRows.length > 0) {
      const intact = twins.filter(isIntact)
      if (intact.length !== 1) {
        if (!ambiguous) skip(`${intact.length} intact csv copies`)
        continue // the person already exists: never insert a second record
      }
      keeper = intact[0]
      plan.rekeys.push({ id: keeper.id, old_id: keeper.mojoId, new_id: contact.mojoId })
    }
    for (const t of twins) if (keeper && t.id !== keeper.id) plan.duplicates.push({ id: t.id, keeper_id: keeper.id })
    plan.upserts.push({ contact, keeper })
  }
  return plan
}

// Keep-old rule for phone/email lists: existing values keep their order, and
// incoming values not already present (compared by key) are appended. A
// blank first slot (phone/email column) is filled first.
export function appendNew(
  first: string | null, rest: string[] | null, incoming: string[], key: (s: string) => string | null,
): { first: string | null; rest: string[] } {
  const kept = rest ?? []
  const seen = new Set([first, ...kept].filter((s): s is string => !!s).map(key))
  const extra: string[] = []
  for (const s of incoming) {
    if (seen.has(key(s))) continue
    seen.add(key(s))
    extra.push(s)
  }
  return first ? { first, rest: [...kept, ...extra] } : { first: extra[0] ?? null, rest: [...kept, ...extra.slice(1)] }
}
