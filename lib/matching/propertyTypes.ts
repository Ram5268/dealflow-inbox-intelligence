// Brief 41 — one property-type vocabulary for both sides of a match.
//
// Buyers write free text ("Multifamily", "SFH", "Coop", "2-family"), while CRM
// sellers carry Mojo's Property Type ("Duplex", "Triplex", "Quadruplex",
// "Multi-Family Dwelling", "Residential Income (Multi-Family)", "Apartment House
// (5+ Units)"). Comparing the raw strings never matched those, so every
// multi-family CRM seller looked like a property-type mismatch. Both sides map to
// one of these classes; text we can't classify returns null (unknown vocabulary).
export type PropertyClass =
  | 'multifamily'
  | 'condo'
  | 'coop'
  | 'townhouse'
  | 'single_family'
  | 'mixed_use'
  | 'land'
  | 'commercial'

// First hit wins, so the more specific ownership types (condo / co-op, and a
// "duplex condo" is an apartment) come before the building types.
const CLASSES: ReadonlyArray<[PropertyClass, RegExp]> = [
  ['mixed_use', /\bmixed[\s-]?use\b/],
  ['coop', /\bco-?ops?\b|\bcooperative\b/],
  ['condo', /\bcondo(minium)?s?\b/],
  ['multifamily', /\bmulti[\s-]?family\b|\bmulti\b|\bduplex\b|\btriplex\b|\bquadruplex\b|\bfourplex\b|\b(two|three|four|2|3|4)[\s-]?family\b|\bapartment house\b|\bresidential income\b/],
  ['townhouse', /\btown[\s-]?(house|home)s?\b|\brow[\s-]?houses?\b|\bbrownstones?\b/],
  ['single_family', /\bsingle[\s-]?family\b|\bsfh\b|\bsfr\b|\b(one|1)[\s-]?family\b|\bdetached\b/],
  ['land', /\bland\b|\bvacant lot\b|\bdevelopment site\b/],
  ['commercial', /\bcommercial\b|\bretail\b|\boffice\b|\bindustrial\b|\bwarehouse\b/],
]

export function propertyClass(text: string | null | undefined): PropertyClass | null {
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return null
  for (const [cls, re] of CLASSES) if (re.test(t)) return cls
  return null
}

// A listing's class: its type text, else 2+ units means a multi-family building.
export function listingPropertyClass(listing: {
  propertyType: string | null
  propertyTypeDetail: string | null
  unitCount: number | null
}): PropertyClass | null {
  return (
    propertyClass(listing.propertyType) ??
    propertyClass(listing.propertyTypeDetail) ??
    ((listing.unitCount ?? 0) >= 2 ? 'multifamily' : null)
  )
}
