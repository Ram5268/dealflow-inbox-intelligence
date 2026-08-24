// Brief 33 — ranker types. The rank UNIT is a CONTACT (MojoContact); a contact's
// many Match rows are aggregated into one AggregatedContact before ranking.
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW' // same shape as the scorer

export interface RankingFeatureResult {
  key: string
  score: number // 0-1 monotonic (higher = better for CallPriority)
  confidence: Confidence
}

export interface AggregatedMatch {
  id: string
  matchFit: number
  captureStatus: string
  contributions: Record<string, number>
}

export interface AggregatedContact {
  contactId: string
  contactType: 'mojoContact' // room to expand later
  topMatch: {
    id: string
    matchFit: number
    matchFitConfidence: Confidence
    captureStatus: string
    createdAt: Date
    contributions: Record<string, number>
  }
  contributingMatches: AggregatedMatch[]
  contact: {
    id: string
    fullName: string
    phone: string | null
    additionalPhones: string[]
    phoneDncFlags: boolean[]
    phoneTypes: string[]
    lastCalled: Date | null
    lastDialDate: Date | null
    status: string | null
    preForeclosureStatus: string | null
    isVacant: boolean | null
    neighborhood: string | null
    tags: string[]
    groups: string[]
  }
}

export interface RankingContext {
  now: Date
}

export interface ContactPriorityResult {
  priorityScore: number // 0-100
  reason: string
  contributions: Record<string, number>
}
