// Brief 27.0 — shared types for the section-composable report generators.
//
// A report is a set of SECTIONS. Each section is generated independently, so a
// full report is "run all sections", and a chat fragment is "run one section".
// Sections are either deterministic (Prisma + matcher + FRED) or Sonnet-composed
// (analytical narrative). Either way they return the same SectionResult shape.
import type { PrismaClient, Category } from '@prisma/client'
import type Anthropic from '@anthropic-ai/sdk'

// Where a fact in a section came from. Mirrors the DataSource union in
// templates.ts plus 'matcher' (the cross-source matching engine's output).
export type SourceType = 'inbox' | 'acris' | 'dob' | 'pluto' | 'streeteasy' | 'fred' | 'matcher'

export type SourceRef = { type: SourceType; id?: string; at: string }

export type SectionContent = {
  prose?: string
  items?: Array<Record<string, unknown>>          // structured items (listings, near-misses…)
  metrics?: Array<{ label: string; value: string; source?: string }>
}

export type SectionResult = {
  key: string
  title: string
  content: SectionContent
  sources: SourceRef[]
}

export type GeneratedReport = {
  sections: SectionResult[]
  markdown: string
  sources: SourceRef[]
  subject: string        // human-readable, e.g. "Sarah — 2026-08-19"
  matchCount: number     // buyer-match: count of curated (HOT) matches
}

// ── buyer-match context ──────────────────────────────────────────────────────
// A demand party: a BUYER_ISO / RENTER_INQUIRY ExtractedOpportunity, or (Brief
// 48 PR 13, Q8) a buyer or renter stored in Ryan's CRM table (a MojoContact with
// intent BUYER / RENTER, read as BUYER_ISO / RENTER_INQUIRY). The persisted Match
// rows key on its id as the counterpart.
export type BuyerRecord = {
  id: string
  category: Category
  name: string
  neighborhoods: string[]
  borough: string | null
  minBeds: number | null
  maxBeds: number | null
  beds: number | null
  minPrice: number | null
  maxPrice: number | null
  price: number | null
  mustHaves: string | null
  dealbreakers: string | null
  timeline: string | null
  propertyTypes: string[]
  isTestData: boolean
  createdAt: Date
}

// One persisted Match row + its listing (the ExtractedOpportunity on the supply
// side). tier: HOT → curated match; WARM/POSSIBLE → near-miss.
export type MatchedListing = {
  matchId: string
  tier: 'HOT' | 'WARM' | 'POSSIBLE' | null
  score: number
  reason: string | null
  listing: {
    id: string
    category: Category | null // Brief 32 — null when the supply is a MojoContact seller (no email classification)
    address: string | null
    neighborhood: string | null
    borough: string | null
    price: number | null
    beds: number | null
    squareFeet: number | null
    extractedTitle: string
    sourceBrokerage: string | null
    sourceAgentName: string | null
    availabilityDate: string | null
    // Brief 41 (H7): a homeowner (CRM/Mojo seller), not a listing: no price,
    // no name, no seller circumstances in anything shown for it.
    isHomeowner: boolean
  }
}

// Shared context handed to every buyer-match section. buyer is loaded eagerly
// (needed for the title/criteria of every section and to validate the id).
// matches() is memoized and lazy: fragment sections that don't need matches
// (e.g. criteria) never trigger the query.
export interface GenContext {
  buyerId: string
  prisma: PrismaClient
  buyer: BuyerRecord
  matches: () => Promise<MatchedListing[]>
  // Brief 48 PR 13 (Q44): the organization every read is scoped to.
  organizationId?: string
}

// A section runner. anthropic is only used by Sonnet-composed sections.
export type SectionRunner = (ctx: GenContext, anthropic?: Anthropic) => Promise<SectionResult>

export function nowISO(): string {
  return new Date().toISOString()
}
