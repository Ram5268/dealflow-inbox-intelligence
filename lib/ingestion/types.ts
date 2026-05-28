import { z } from 'zod'

// ── Extractor versioning ──────────────────────────────────────────────────────
export const PROMPT_VERSION  = '1.0'
export const SCHEMA_VERSION  = '1.0'

// ── Classifier input (cheap — no full body) ───────────────────────────────────
export interface ClassifierInput {
  rawEmailId:       string
  subject:          string
  senderName:       string | null
  senderEmail:      string | null
  bodyPreview:      string | null
  bodyFirst500:     string | null    // first 500 chars of full body for vague emails
  attachmentNames:  string[]
  attachmentMimeTypes: string[]
  attachmentCount:  number
}

export interface ClassifierOutput {
  category:         string
  confidence:       number           // 0–1
  needsDeepExtract: boolean
  isMultiListing:   boolean
  extractorVersion: string
}

// ── Full extractor input (includes body + attachments) ────────────────────────
export interface ExtractorInput extends ClassifierInput {
  fullBody:         string | null
  attachmentText:   string | null
}

// ── Shared Zod field definitions ──────────────────────────────────────────────
const nullableString = z.string().nullable().optional()
const nullableFloat  = z.number().nullable().optional()
const nullableInt    = z.number().int().nullable().optional()

// ── Per-category Zod schemas ──────────────────────────────────────────────────

export const SaleListingSchema = z.object({
  address:          z.string().nullable(),
  unitNumber:       nullableString,
  neighborhood:     nullableString,
  borough:          nullableString,
  city:             nullableString,
  state:            nullableString,
  zip:              nullableString,
  price:            nullableFloat,
  beds:             nullableFloat,
  baths:            nullableFloat,
  squareFeet:       nullableFloat,
  propertyType:     nullableString,
  availabilityDate: nullableString,
  status:           nullableString,
  sourceAgentName:  nullableString,
  sourceAgentEmail: nullableString,
  sourceBrokerage:  nullableString,
  extractedTitle:   z.string(),
  extractedSummary: z.string(),
  classificationReason: z.string(),
  confidenceScore:  z.number().min(0).max(1),
})
export type SaleListing = z.infer<typeof SaleListingSchema>

export const RentalListingSchema = SaleListingSchema.extend({
  minPrice: nullableFloat,
  maxPrice: nullableFloat,
})
export type RentalListing = z.infer<typeof RentalListingSchema>

export const BuyerISOSchema = z.object({
  neighborhoods:    z.array(z.string()).default([]),
  borough:          nullableString,
  minPrice:         nullableFloat,
  maxPrice:         nullableFloat,
  minBeds:          nullableInt,
  maxBeds:          nullableInt,
  beds:             nullableFloat,
  propertyTypes:    z.array(z.string()).default([]),
  mustHaves:        nullableString,
  dealbreakers:     nullableString,
  sourceAgentName:  nullableString,
  sourceAgentEmail: nullableString,
  sourceBrokerage:  nullableString,
  clientSide:       nullableString,
  extractedTitle:   z.string(),
  extractedSummary: z.string(),
  classificationReason: z.string(),
  confidenceScore:  z.number().min(0).max(1),
})
export type BuyerISO = z.infer<typeof BuyerISOSchema>

export const RenterInquirySchema = z.object({
  neighborhoods:    z.array(z.string()).default([]),
  borough:          nullableString,
  maxPrice:         nullableFloat,
  minBeds:          nullableInt,
  maxBeds:          nullableInt,
  beds:             nullableFloat,
  moveInDate:       nullableString,
  propertyTypes:    z.array(z.string()).default([]),
  sourceAgentName:  nullableString,
  sourceAgentEmail: nullableString,
  sourceBrokerage:  nullableString,
  extractedTitle:   z.string(),
  extractedSummary: z.string(),
  classificationReason: z.string(),
  confidenceScore:  z.number().min(0).max(1),
})
export type RenterInquiry = z.infer<typeof RenterInquirySchema>

export const ShowingConfirmationSchema = z.object({
  address:          z.string().nullable(),
  neighborhood:     nullableString,
  confirmedDate:    nullableString,
  confirmedTime:    nullableString,
  confirmingAgent:  nullableString,
  confirmingEmail:  nullableString,
  attendee:         nullableString,
  extractedTitle:   z.string(),
  extractedSummary: z.string(),
  classificationReason: z.string(),
  confidenceScore:  z.number().min(0).max(1),
})
export type ShowingConfirmation = z.infer<typeof ShowingConfirmationSchema>

// ── Generic extraction result (compatible with existing ExtractedOpportunity) ─
export interface ExtractionResult {
  isRelevant:           boolean
  category:             string
  transactionType:      string
  propertyType:         string | null
  address:              string | null
  neighborhood:         string | null
  borough:              string | null
  city:                 string | null
  state:                string | null
  zip:                  string | null
  price:                number | null
  minPrice:             number | null
  maxPrice:             number | null
  beds:                 number | null
  baths:                number | null
  units:                number | null
  squareFeet:           number | null
  availabilityDate:     string | null
  sourceAgentName:      string | null
  sourceAgentEmail:     string | null
  sourceBrokerage:      string | null
  clientSide:           string | null
  status:               string | null
  extractedTitle:       string
  extractedSummary:     string
  classificationReason: string
  confidenceScore:      number
  // Phase 2 additions
  propertyId?:          string | null
  processingStatus?:    string
  flagReasons?:         string[]
  duplicateOfId?:       string | null
  // Phase X.1 — populated by SE auto-match before persist when the
  // record is supply-side and has an address. NULL when no match was
  // found, the API errored, or quota is paused.
  streetEasyId?:        string | null
  streetEasyStatus?:    string | null
  streetEasyCheckedAt?: Date | null
}

// ── Validation flag types ─────────────────────────────────────────────────────
export type FlagReason =
  | 'low_confidence'
  | 'ambiguous_category'
  | 'missing_address'
  | 'possible_duplicate'
  | 'conflicting_category'
  | 'schema_validation_failed'
  | 'multi_listing_ambiguity'
  | 'missing_date'
  | 'price_sanity'

export interface ValidationFlag {
  reason:    FlagReason
  severity:  'warning' | 'block'  // warning → active+review, block → needs_review
  message:   string
}
