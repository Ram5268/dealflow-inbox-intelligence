// Brief 34: street normalizer for equality checks (owner-occupied test and
// duplicate grouping), never for display. Handles case, punctuation, Mojo's
// unit suffixes ("# 3", "Apt 4"), ordinals, Queens hyphenated house numbers
// and the common street-word abbreviations.
const WORDS: Record<string, string> = {
  st: 'street', str: 'street', ave: 'avenue', av: 'avenue', pl: 'place', rd: 'road', dr: 'drive',
  blvd: 'boulevard', pkwy: 'parkway', ct: 'court', ln: 'lane', ter: 'terrace', hwy: 'highway',
  sq: 'square', ft: 'fort', mt: 'mount', n: 'north', s: 'south', e: 'east', w: 'west',
}

export function normalizeStreet(raw: string | null | undefined): string | null {
  const tokens = (raw ?? '').toLowerCase()
    .replace(/\s*(#|\b(apt|apartment|unit|ste|suite|fl|floor)\b).*$/, '') // unit suffix
    .replace(/(\d)-(\d)/g, '$1$2') // 18-14 → 1814
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().split(' ').filter(Boolean)
    .map(t => t.replace(/^(\d+)(st|nd|rd|th)$/, '$1')) // 54th → 54
  // "St" right after the house number means Saint (115 St Marks Ave).
  const words = tokens.map((t, i) => (t === 'st' && i === 1 && /^\d/.test(tokens[0]) ? 'saint' : WORDS[t] ?? t))
  return words.length ? words.join(' ') : null
}

const normCity = (c: string | null | undefined) => (c ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

// true: mailing street and city equal the property's. false: they differ.
// null: there's no mailing address.
export function isOwnerOccupied(
  propertyStreet: string | null, propertyCity: string | null,
  mailingStreet: string | null, mailingCity: string | null,
): boolean | null {
  const mailing = normalizeStreet(mailingStreet)
  if (!mailing) return null
  return mailing === normalizeStreet(propertyStreet) && normCity(mailingCity) === normCity(propertyCity)
}
