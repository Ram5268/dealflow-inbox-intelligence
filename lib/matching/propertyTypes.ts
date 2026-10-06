// Brief 41 — one property-type vocabulary for both sides of a match.
//
// Buyers write free text ("Multifamily", "SFH", "Coop", "2-family"), while CRM
// sellers carry Mojo's Property Type ("Duplex", "Triplex", "Quadruplex",
// "Multi-Family Dwelling", "Residential Income (Multi-Family)", "Apartment House
// (5+ Units)"). Comparing the raw strings never matched those, so every
// multi-family CRM seller looked like a property-type mismatch. Both sides map to
// these classes. A text can carry more than one ("Mixed-Use Multi-Family" is
// mixed use AND multi-family); text we can't classify gives none (unknown).
export type PropertyClass =
  | 'multifamily'
  | 'condo'
  | 'coop'
  | 'townhouse'
  | 'single_family'
  | 'mixed_use'
  | 'land'
  | 'commercial'

const CLASSES: ReadonlyArray<[PropertyClass, RegExp]> = [
  ['mixed_use', /\bmixed[\s-]?use\b/],
  ['coop', /\bco[\s-]?ops?\b|\bco-?operatives?\b/],
  ['condo', /\bcondo(minium)?s?\b|\bcondops?\b/],
  ['multifamily', /\bmulti[\s-]?family\b|\bmulti[\s-]?unit\b|\bmultis?\b(?![\s-]?(level|story|storey))|\bmultiplex(es)?\b|\bquadruplex(es)?\b|\bfourplex(es)?\b|\b([2-9]|two|three|four|five|six)[\s-]?family\b|\bapartment (house|building)s?\b|\bresidential income\b/],
  ['townhouse', /\btown[\s-]?(house|home)s?\b|\brow[\s-]?houses?\b|\bbrownstones?\b/],
  ['single_family', /\bsingle[\s-]?family\b|\bsfh\b|\bsfr\b|\b(one|1)[\s-]?family\b|\bdetached\b/],
  ['land', /\bland\b|\bvacant lot\b|\bdevelopment site\b/],
  ['commercial', /\bcommercial\b|\bretail\b|\boffice\b|\bindustrial\b|\bwarehouse\b/],
]

// "Duplex" / "triplex" is a 2-3 family house (Mojo's meaning), unless the text is
// about an apartment: a "duplex condo" or "duplex penthouse" is a two-level unit.
const LAYOUT_WORDS = /\b(duplex|triplex)(es)?\b/
const APARTMENT_CONTEXT = /\b(apartment|apt|penthouse|unit|condo(minium)?s?|condops?|co[\s-]?ops?|co-?operatives?|loft)\b/

// `context` is the wider text the word came from: a buyer asking for
// ["Condo", "Duplex"] means a duplex apartment.
export function propertyClasses(text: string | null | undefined, context?: string): Set<PropertyClass> {
  const t = (text ?? '').toLowerCase()
  const out = new Set<PropertyClass>()
  for (const [cls, re] of CLASSES) if (re.test(t)) out.add(cls)
  const ctx = `${t} ${(context ?? '').toLowerCase()}`
  if (LAYOUT_WORDS.test(t) && !APARTMENT_CONTEXT.test(ctx)) out.add('multifamily')
  return out
}

// A listing's classes: its type text, plus multi-family when it has 2+ units.
export function listingPropertyClasses(listing: {
  propertyType: string | null
  propertyTypeDetail: string | null
  unitCount: number | null
}): Set<PropertyClass> {
  const out = propertyClasses(`${listing.propertyType ?? ''} ${listing.propertyTypeDetail ?? ''}`)
  if ((listing.unitCount ?? 0) >= 2) out.add('multifamily')
  return out
}
