// Phase 4.6 — NYC DOF building-class code → canonical propertyType.
// `needsAcrisCheck` flags codes that are ambiguous between rental multi-family
// and a condo/co-op conversion; those trigger the optional ACRIS lookup.
export type PropertyType = 'single-family' | 'townhouse' | 'multi-family' | 'co-op' | 'condo' | 'mixed-use' | 'loft' | 'commercial'
export interface ClassMapping { type: PropertyType | null; needsAcrisCheck?: boolean; description: string }

export const BLDG_CLASS_TO_PROPERTY_TYPE: Record<string, ClassMapping> = {
  // A — One family (A5/A7 = townhouse)
  A0: { type: 'single-family', description: 'One Family: Cape Cod' },
  A1: { type: 'single-family', description: 'One Family: Two Stories Detached' },
  A2: { type: 'single-family', description: 'One Family: One Story' },
  A3: { type: 'single-family', description: 'One Family: Large Suburban' },
  A4: { type: 'single-family', description: 'One Family: City Residence' },
  A5: { type: 'townhouse',     description: 'One Family: Attached or Semi-Detached' },
  A6: { type: 'single-family', description: 'One Family: Summer Cottage / Mobile Home' },
  A7: { type: 'townhouse',     description: 'One Family: Mansion or Town House' },
  A8: { type: 'single-family', description: 'One Family: Bungalow Colony / Land Coop' },
  A9: { type: 'single-family', description: 'One Family: Miscellaneous' },
  // B — Two family
  B1: { type: 'multi-family', description: 'Two Family: Brick' },
  B2: { type: 'multi-family', description: 'Two Family: Frame' },
  B3: { type: 'multi-family', description: 'Two Family: Converted from One Family' },
  B9: { type: 'multi-family', description: 'Two Family: Miscellaneous' },
  // C — Walk-up (ambiguous except C6/C8)
  C0: { type: 'multi-family', needsAcrisCheck: true, description: 'Walk-Up: Three Families' },
  C1: { type: 'multi-family', needsAcrisCheck: true, description: 'Walk-Up: 6+ Families No Stores' },
  C2: { type: 'multi-family', needsAcrisCheck: true, description: 'Walk-Up: 5-6 Families' },
  C3: { type: 'multi-family', needsAcrisCheck: true, description: 'Walk-Up: Four Families' },
  C4: { type: 'multi-family', needsAcrisCheck: true, description: 'Walk-Up: Old Law Tenement' },
  C5: { type: 'multi-family', needsAcrisCheck: true, description: 'Walk-Up: Converted Dwelling' },
  C6: { type: 'co-op',        description: 'Walk-Up: Cooperative' },
  C7: { type: 'multi-family', needsAcrisCheck: true, description: 'Walk-Up: 6+ Families With Stores' },
  C8: { type: 'co-op',        description: 'Walk-Up: Co-op Conversion From Loft/Warehouse' },
  C9: { type: 'multi-family', needsAcrisCheck: true, description: 'Walk-Up: Garden Apartments' },
  CM: { type: 'multi-family', needsAcrisCheck: true, description: 'Walk-Up: Mobile Homes / Trailer Parks' },
  // D — Elevator (ambiguous except D0/D4)
  D0: { type: 'co-op',        description: 'Elevator: Co-op Conversion From Loft/Warehouse' },
  D1: { type: 'multi-family', needsAcrisCheck: true, description: 'Elevator: Semi-Fireproof Without Stores' },
  D2: { type: 'multi-family', needsAcrisCheck: true, description: 'Elevator: Artists in Residence' },
  D3: { type: 'multi-family', needsAcrisCheck: true, description: 'Elevator: Fireproof Without Stores' },
  D4: { type: 'co-op',        description: 'Elevator: Cooperatives' },
  D5: { type: 'multi-family', needsAcrisCheck: true, description: 'Elevator: Converted' },
  D6: { type: 'multi-family', needsAcrisCheck: true, description: 'Elevator: Fireproof With Stores' },
  D7: { type: 'multi-family', needsAcrisCheck: true, description: 'Elevator: Semi-Fireproof With Stores' },
  D8: { type: 'multi-family', needsAcrisCheck: true, description: 'Elevator: Luxury Type' },
  D9: { type: 'multi-family', needsAcrisCheck: true, description: 'Elevator: Miscellaneous' },
  // R — Condos (clean signal; R9 is condop)
  R0: { type: 'condo',      description: 'Condo Billing Lot (header)' },
  R1: { type: 'condo',      description: 'Condo Residential Unit in 2-10 Unit Building' },
  R2: { type: 'condo',      description: 'Condo Residential Unit in Walk-Up Building' },
  R3: { type: 'condo',      description: 'Condo Residential Unit in 1-3 Story Building' },
  R4: { type: 'condo',      description: 'Condo Residential Unit in Elevator Building' },
  R5: { type: 'commercial', description: 'Condo Miscellaneous Commercial Unit' },
  R6: { type: 'condo',      description: 'Condo Residential Unit in 1-3 Unit Building' },
  R7: { type: 'commercial', description: 'Condo Commercial Unit in 1-3 Unit Building' },
  R8: { type: 'commercial', description: 'Condo Commercial Unit in 2-10 Unit Building' },
  R9: { type: 'co-op',      description: 'Condop (co-op inside a condo wrapper)' },
  RA: { type: 'commercial', description: 'Condo Cultural/Medical/Educational' },
  RB: { type: 'commercial', description: 'Condo Office Buildings' },
  RC: { type: 'commercial', description: 'Condo Commercial Building' },
  RD: { type: 'condo',      description: 'Condo Residential Building' },
  RG: { type: null,         description: 'Condo Indoor Parking (ancillary)' },
  RH: { type: 'commercial', description: 'Condo Hotel / Boatel' },
  RI: { type: 'mixed-use',  description: 'Condo Mixed Warehouse + Commercial' },
  RK: { type: 'commercial', description: 'Condo Store Buildings - Retail' },
  RM: { type: 'mixed-use',  description: 'Condo Mixed Residential & Commercial' },
  RP: { type: null,         description: 'Condo Outdoor Parking (ancillary)' },
  RR: { type: 'condo',      description: 'Condo Rental (unit is condo, currently rented)' },
  RS: { type: null,         description: 'Condo Non-Business Storage (ancillary)' },
  RT: { type: null,         description: 'Condo Terraces/Gardens/Cabanas (ancillary)' },
  RW: { type: 'commercial', description: 'Condo Warehouse / Factory / Industrial' },
  RX: { type: 'mixed-use',  description: 'Condo Mixed Residential, Commercial & Industrial' },
  RZ: { type: 'mixed-use',  description: 'Condo Mixed Residential & Warehouse' },
  // S — Mixed residence + commercial
  S0: { type: 'mixed-use', description: 'Mixed: 1-Fam + 2 Stores/Offices' },
  S1: { type: 'mixed-use', description: 'Mixed: 1-Fam + 1 Store/Office' },
  S2: { type: 'mixed-use', description: 'Mixed: 2-Fam + 1 Store/Office' },
  S3: { type: 'mixed-use', description: 'Mixed: 3-Fam + 1 Store/Office' },
  S4: { type: 'mixed-use', description: 'Mixed: 4-Fam + 1 Store/Office' },
  S5: { type: 'mixed-use', description: 'Mixed: 5-6 Fam + 1 Store/Office' },
  S9: { type: 'mixed-use', description: 'Mixed: 1-6 Fam + Stores/Offices' },
  // L — Loft buildings
  L1: { type: 'loft', description: 'Loft: 8+ Stories' },
  L2: { type: 'loft', description: 'Loft: Fireproof Loft/Storage' },
  L3: { type: 'loft', description: 'Loft: Semi-Fireproof' },
  L8: { type: 'loft', description: 'Loft: With Retail Stores' },
  L9: { type: 'loft', description: 'Loft: Miscellaneous' },
  // O — Office
  O1: { type: 'commercial', description: 'Office: Up to 9 Stories' },
  O2: { type: 'commercial', description: 'Office: 2-6 Stories' },
  O3: { type: 'commercial', description: 'Office: 7-19 Stories' },
  O4: { type: 'commercial', description: 'Office: Tower Type 20+' },
  O5: { type: 'commercial', description: 'Office: With Commercial 1-6 Stories' },
  O6: { type: 'commercial', description: 'Office: With Commercial 7-19 Stories' },
  O7: { type: 'commercial', description: 'Office: Professional / Funeral Homes' },
  O8: { type: 'mixed-use',  description: 'Office: With Residential' },
  O9: { type: 'commercial', description: 'Office: Misc / Old Style Bank' },
  // F — Factory/Industrial → commercial
  F1: { type: 'commercial', description: 'Factory: Heavy Manufacturing' },
  F2: { type: 'commercial', description: 'Factory: Special Construction' },
  F4: { type: 'commercial', description: 'Factory: Semi-Fireproof' },
  F5: { type: 'commercial', description: 'Factory: Light Manufacturing' },
  F8: { type: 'commercial', description: 'Factory: Tank Farms' },
  F9: { type: 'commercial', description: 'Factory: Miscellaneous' },
}

export function classifyBuildingClass(code: string | null | undefined): ClassMapping {
  if (!code) return { type: null, description: 'unknown_class' }
  const key = code.trim().toUpperCase()
  return BLDG_CLASS_TO_PROPERTY_TYPE[key] ?? { type: null, description: `unknown_class:${key}` }
}

const COOP_OWNERNAME = /\b(TENANTS|OWNERS|APARTMENT|TENANT)\s+(CORP|CORPORATION)\b/i
export function looksLikeCoopOwner(ownername: string | null | undefined): boolean {
  return !!ownername && COOP_OWNERNAME.test(ownername)
}
