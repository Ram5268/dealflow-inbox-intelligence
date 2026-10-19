// Brief 43 PR 11 (Q16): the address and borough Drift's city-records side
// lookups (deeds: ./acris.ts; permits and violations: ./dob.ts) search.
//
// The borough is the one typed with the address, else one named elsewhere in
// the message, else the parsed query's; with none, Brooklyn (ASSUMED_BOROUGH),
// and the block tells Drift it was assumed, so it can say so or ask (DRIFT_SCRIPT
// #21, #22). The note has no link and no tool or system names: Drift may
// repeat it [engineering precaution].
import { findAddressInText, ASSUMED_BOROUGH, BOROUGH_NAMES, type BoroughCode, type AddressInText } from '@/lib/acris'
import type { ParsedQuery } from '@/lib/retrieval/types'

export interface CityRecordsAddress {
  /** The street address as typed: "418 Marigold Street". */
  street: string
  boroughCode: BoroughCode
  boroughName: string
  /** What the lookups are given, and the block shows: "418 Marigold Street, Brooklyn". */
  display: string
  /** '' when the borough was typed; otherwise a line for the end of the block. */
  note: string
}

export function boroughNote(from: AddressInText['boroughFrom'], boroughName: string): string {
  if (from === 'address' || from === 'message') return ''
  if (from === 'hint') {
    return `\nBOROUGH NOTE: Borough taken as ${boroughName} from the question; Ryan didn't type one. Say which borough these records are for in one short line.`
  }
  return `\nBOROUGH NOTE: Borough assumed: ${boroughName}, because the message didn't name a borough, zip or neighborhood. Say so in one short line, and ask Ryan if he meant another borough.`
}

export function cityRecordsAddress(userMessage: string, parsed: Pick<ParsedQuery, 'boroughs'>): CityRecordsAddress | null {
  const found = findAddressInText(userMessage, { boroughs: parsed.boroughs })
  if (!found) return null
  const boroughCode = found.boroughCode ?? ASSUMED_BOROUGH
  const boroughName = BOROUGH_NAMES[boroughCode]
  return {
    street: found.street,
    boroughCode,
    boroughName,
    display: `${found.street}, ${boroughName}`,
    note: boroughNote(found.boroughCode ? found.boroughFrom : null, boroughName),
  }
}
