// Brief 43 PR 5 (D11 [Ryan, 2026-10-18]): the one CRM-seller contact Drift may
// give, as a structured card the chat page renders (name, phone, address, an
// "Open in CRM" button, a "Do not contact" badge). The link travels as data,
// never in Drift's text: any URL in its text trips the guard (Q19).
//
// No server imports here, so the page can use these types and helpers too.
// Brief 43 PR 3's draft check finds homeowners in a turn's tool output by
// `kind: 'crm_seller'`; PR 6 and PR 12 extend these shapes (CONTRACT.md).
export type SellerCard = {
  kind: 'crm_seller'
  id: string
  name: string
  phone: string | null          // "(718) 555-0142"
  address: string | null
  neighborhood: string | null
  lastCallResult: string | null
  status: string | null
  doNotContact: boolean
  crmUrl: string | null         // crmLeadUrl(metadata), lib/crmLink.ts
}

// find_seller's "which one?" answer: a name and an area, nothing to contact.
export type SellerCandidate = { kind: 'crm_seller'; id: string; name: string; neighborhood: string | null }

export function isSellerCard(x: unknown): x is SellerCard {
  return !!x && typeof x === 'object' && (x as { kind?: unknown }).kind === 'crm_seller' && 'crmUrl' in x
}

// Q39: CRM phones are stored as 10 raw digits (lib/crm-sync/mapLead.ts phoneKey).
// A US number reads "(718) 555-0142"; anything else is shown as stored.
export function formatPhone(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  const digits = trimmed.replace(/\D/g, '')
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : trimmed
}

// Opt-out wording in a call result ("Do Not Call", "DNC", "remove me", "stop
// calling", ...). Matched as whole words on lowercased text with punctuation
// turned into spaces, like the CRM's own SMS opt-out reader
// (src/lib/comms/sms/opt-out.ts). "Not interested" alone is not an opt-out, and
// neither is "stop" inside a longer note ("may stop by"); a bare "STOP" is.
// When in doubt this leans to "do not contact" [engineering precaution]: a note
// such as "do not call after 8pm" or "DNC list checked" also marks the
// homeowner, and that is the safe direction (Ryan checks the CRM; nobody is
// called by mistake).
const OPT_OUT_PHRASES = [
  'do not call', 'dont call', 'never call', 'do not contact', 'dont contact', 'do not text', 'dont text',
  'do not email', 'dont email', 'do not solicit', 'no solicitation', 'dnc', 'd n c', 'dncd', 'remove me',
  'remove from list', 'remove from the list', 'removed from list', 'removed from the list', 'take me off',
  'take off list', 'take off the list', 'opt out', 'optout', 'opted out', 'unsubscribe', 'unsubscribed',
  'stop calling', 'stop texting', 'stop contacting', 'please stop', 'cease and desist', 'no more calls',
  'asked not to be called', 'asked not to be contacted', 'asked to be removed',
]

export function isOptOutWording(text: string | null | undefined): boolean {
  const t = (text ?? '').replace(/['’‘`]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (!t) return false
  if (t === 'stop') return true
  const padded = ` ${t} `
  return OPT_OUT_PHRASES.some(p => padded.includes(` ${p} `))
}
