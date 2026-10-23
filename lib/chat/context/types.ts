import type { ParsedQuery } from '@/lib/retrieval/types'

export interface ContextInput {
  parsed:           ParsedQuery       // intent flags from runRetrieval (drives most triggers)
  userMessage:      string             // raw text — needed for address extraction (ACRIS/DOB)
  queryText:        string             // lowercased — for keyword/match-substring checks
  isConfirmMessage: boolean            // true when current message is "confirm" reply (calendar)
  // Brief 43 PR 13 (Q22): the message is a long paste, so userMessage and
  // queryText hold only Ryan's own lead-in, and the paid StreetEasy search stays off.
  pastedText?:      boolean
}

export interface LiveSeListing {
  id:    string
  url:   string
  price: number | null
}

export interface ContextResult {
  block: string | null
  // Optional structured payloads — currently only liveStreetEasy populates these.
  // Forwarded to the response JSON by route.ts.
  liveSeListings?: LiveSeListing[]
  seFilterUrl?:    string | null
}

export type ContextFetcher = (input: ContextInput) => Promise<ContextResult>
