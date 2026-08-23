// Brief 32 — hand-set, tunable feature weights. Single source of truth.
//
// Weights are RELATIVE: their magnitudes matter only against each other. The
// planner tunes these after observing the first-run distribution — do NOT
// "correct" them silently. Absolute values are meaningless in isolation because
// composeMatchFit normalizes by the total effective weight before the sigmoid.
export const WEIGHTS: Record<string, number> = {
  neighborhood:            2.5,
  price:                   2.0,
  beds:                    1.8,
  baths:                   0.7,
  propertyType:            1.2,
  carryingReasonableness:  1.5,
  outdoorSpace:            0.8,
  buildingAmenity:         0.8,
  highEquity:              1.0,
  freeAndClear:            0.6,
  goldenHandcuff:          0.9,
  absenteeOwner:           0.9,
  vacancy:                 1.2,
  preForeclosure:          3.0, // largest motivation signal
  foreclosureUrgency:      2.0,
  tenure:                  0.5,
  sourceListMotivation:    1.0,
  substitutionScarcity:    0.6,
  buyerArchetypeSituation: 1.5,
  recency:                 0.4,
}

export function getWeight(key: string): number {
  if (!(key in WEIGHTS)) {
    throw new Error(`No weight configured for feature key: ${key}`)
  }
  return WEIGHTS[key]
}
