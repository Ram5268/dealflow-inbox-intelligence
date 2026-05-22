// Contacts in these Mojo groups are active relationships — never email them from cold campaigns.
// All five groups must match exactly as they appear in Mojo.
export const NYC_LEAD_GROUPS = [
  'NYC Landlords(Rental Leads)',
  'NYC Appointment Set',
  'NYC Hot',
  'NYC Nuture',
  'On Market',
]

export function isSuppressed(groups: string[], status?: string | null): boolean {
  if (groups.some(g => NYC_LEAD_GROUPS.includes(g))) return true
  if (status === 'Email Reply' || status === 'Email Interested') return true
  return false
}
