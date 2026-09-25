import type { CrmLeadRow } from './crmReader'
import { isOwnerOccupied } from './addressNormalize'
import { zipToNeighborhood } from '../geo/zipNeighborhood'

// Brief 34: pure mapping of one CRM lead onto MojoContact fields. null means
// the CRM has nothing, and the upsert only ever fills blanks with these values.
// Custom fields are read by definition name, as the Mojo XLSX importer made them.
export type CrmContact = ReturnType<typeof mapLead>

const UNITS: Record<string, number> = { Duplex: 2, Triplex: 3, Quadruplex: 4, 'Apartment House (5+ Units)': 5 }

const clean = (s: string | null | undefined): string | null => (s ?? '').replace(/\s+/g, ' ').trim() || null
const unique = (xs: (string | null)[]): string[] => [...new Set(xs.filter((x): x is string => !!x))]

export const phoneKey = (p: string): string | null => {
  const digits = p.replace(/\D/g, '')
  return digits.length >= 10 ? digits.slice(-10) : null
}

export function mapLead(lead: CrmLeadRow) {
  const text = (k: string) => clean(lead.fields[k]?.t)
  const num = (k: string) => lead.fields[k]?.n ?? null
  const date = (k: string) => lead.fields[k]?.d ?? null
  const int = (k: string) => (num(k) == null ? null : Math.round(num(k) as number))
  const nonZero = (k: string) => num(k) || null // Mojo exports 0 for unknown beds/baths

  const fullName = clean(lead.name) ?? clean(lead.displayName) ?? lead.mojoId
  const coOwner = clean(lead.contactName)
  const address = clean(lead.primaryAddressFull?.split(',')[0])
  const city = text('Property City')
  const mailing = text('Mailing Address')
  const propertyType = text('Property Type')
  const lastCallResult = text('Last Call Result')

  return {
    mojoId: lead.mojoId,
    fullName,
    coOwnerFullName: coOwner && coOwner.toLowerCase() !== fullName.toLowerCase() ? coOwner : null,
    phones: unique(lead.phones.map(phoneKey)), // 10 digits (DealFlow's format), primary first
    emails: unique(lead.emails.map(e => e.trim().toLowerCase())),
    address,
    city,
    state: text('Property State'),
    zipCode: text('Property Zip Code')?.match(/^\d{5}/)?.[0] ?? null,
    neighborhood: zipToNeighborhood(text('Property Zip Code')), // only written when inserting
    propertyTypeDetail: propertyType,
    unitCount: propertyType ? UNITS[propertyType] ?? null : null,
    propertyBeds: nonZero('Bedrooms'),
    propertyBaths: nonZero('Bathrooms'),
    buildingSqft: num('Square Footage'),
    yearBuilt: int('Year Built'),
    lastSaleDate: date('Home Close Date'),
    alternateAddress: mailing ? [mailing, text('Mailing City'), text('Mailing State')].filter(Boolean).join(', ') : null,
    ownerOccupied: isOwnerOccupied(address, city, mailing, text('Mailing City')),
    lastDialDate: date('Last Dial Date'),
    lastCalled: date('Last Contacted Date') ?? date('Last Dial Date'),
    mojoList: text('Dialer List'),
    status: lastCallResult,
    notes: lead.fields['Notes']?.t?.trim() || null,
    metadata: {
      source: 'crm' as const, crmLeadId: lead.id, crmUpdatedAt: lead.updatedAt,
      callAttempts: num('Call Attempts'), lastCallResult, syncVersion: 1 as const,
    },
  }
}
