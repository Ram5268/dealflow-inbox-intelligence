import type { ExtractorInput, ExtractionResult } from '../types'

export function noiseHandler(input: ExtractorInput): ExtractionResult[] {
  return [{
    isRelevant:           false,
    category:             'NOISE',
    transactionType:      'UNKNOWN',
    propertyType:         null,
    address:              null,
    neighborhood:         null,
    borough:              null,
    city:                 null,
    state:                null,
    zip:                  null,
    price:                null,
    minPrice:             null,
    maxPrice:             null,
    beds:                 null,
    baths:                null,
    units:                null,
    squareFeet:           null,
    availabilityDate:     null,
    sourceAgentName:      null,
    sourceAgentEmail:     null,
    sourceBrokerage:      null,
    clientSide:           null,
    status:               null,
    extractedTitle:       input.subject ?? '(no subject)',
    extractedSummary:     'Email classified as not real estate relevant.',
    classificationReason: 'Source classifier determined this email does not contain actionable real estate content.',
    confidenceScore:      1.0,
    processingStatus:     'active',
  }]
}
