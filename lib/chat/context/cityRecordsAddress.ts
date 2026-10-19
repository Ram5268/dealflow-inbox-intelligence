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
  if (from === 'address') return ''
  // Brief 43 PR 11 review: a borough named elsewhere in the message ("my
  // Queens buyer asked who owns …") may not be the building's, so Drift says
  // which borough it searched [engineering precaution].
  if (from === 'message') {
    return `\nBOROUGH NOTE: Borough taken as ${boroughName} from elsewhere in the message, not typed with the address. Say which borough these records are for in one short line.`
  }
  if (from === 'hint') {
    return `\nBOROUGH NOTE: Borough taken as ${boroughName} from the question; Ryan didn't type one. Say which borough these records are for in one short line.`
  }
  // Brief 43 PR 11 review: two boroughs named ("Brooklyn or Queens") is not
  // "no borough" [engineering precaution].
  if (from === 'conflict') {
    return `\nBOROUGH NOTE: The message named more than one borough, so ${boroughName} was searched. Say so in one short line, and ask Ryan which borough he meant.`
  }
  return `\nBOROUGH NOTE: Borough assumed: ${boroughName}, because the message didn't name a borough, zip or neighborhood. Say so in one short line, and ask Ryan if he meant another borough.`
}

// Brief 43 PR 11 review (L4; DRIFT_SCRIPT #22): a follow-up that points back
// ("any permits or violations there?", "who owns it?") and has no address of
// its own uses the address in Ryan's previous message, and says so
// [engineering precaution].
const REFERS_BACK = /\b(?:there|it|that (?:building|house|home|property|place|one|address)|this (?:building|house|home|property|place|one)|same (?:building|address|property))\b/i

export function cityRecordsAddress(userMessage: string, parsed: Pick<ParsedQuery, 'boroughs'>, previousUserMessage?: string | null): CityRecordsAddress | null {
  let found = findAddressInText(userMessage, { boroughs: parsed.boroughs })
  let fromEarlier = false
  if (!found && previousUserMessage && REFERS_BACK.test(userMessage)) {
    found = findAddressInText(previousUserMessage)
    fromEarlier = found !== null
  }
  if (!found) return null
  const boroughCode = found.boroughCode ?? ASSUMED_BOROUGH
  const boroughName = BOROUGH_NAMES[boroughCode]
  return {
    street: found.street,
    boroughCode,
    boroughName,
    display: `${found.street}, ${boroughName}`,
    note: boroughNote(found.boroughCode || found.boroughFrom === 'conflict' ? found.boroughFrom : null, boroughName) + (fromEarlier
      ? `\nADDRESS NOTE: These records are for ${found.street}, ${boroughName}, the address in Ryan's previous message. Say which address in one short line.`
      : ''),
  }
}
