// Brief 35: link from a CRM-sourced seller (MojoContact.metadata.crmLeadId) to its
// lead page in the CRM. null when the contact didn't come from the CRM.
export function crmLeadUrl(metadata: unknown): string | null {
  const id = (metadata as { crmLeadId?: unknown } | null)?.crmLeadId
  if (typeof id !== 'string' || !id) return null
  const base = process.env.NEXT_PUBLIC_CRM_BASE_URL ?? 'https://dealflow-crm-rho.vercel.app'
  return `${base.replace(/\/$/, '')}/leads/${encodeURIComponent(id)}`
}
