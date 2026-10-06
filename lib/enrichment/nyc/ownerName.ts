// Brief 41 (H8): PLUTO's `ownername` is read in memory only, to spot co-op
// corporations ("… OWNERS CORP"). It is never stored or shown: the reason
// records that the heuristic fired, not the name.
export const COOP_OWNER_REASON = 'ownername_corp'

// Reasons written before Brief 41 (and cached ones) carried the name:
// "pluto_class=D4+ownername_corp:123 MAIN ST OWNERS CORP". Drop it.
export function withoutOwnerName(reason: string): string {
  return reason.replace(/ownername_corp:[^+]*/g, COOP_OWNER_REASON)
}
