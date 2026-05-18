import type { ExtractorInput, ExtractionResult } from './types'

type ExtractorFn = (input: ExtractorInput) => Promise<ExtractionResult[]>

// Lazy-loaded extractors — only imported when needed so unused modules don't
// add startup cost to the classifier path.
const EXTRACTOR_MAP: Record<string, () => Promise<{ default?: ExtractorFn; extract?: ExtractorFn }>> = {
  ACTIVE_SALE_LISTING:  () => import('./extractors/saleListingExtractor'),
  BACK_ON_MARKET:       () => import('./extractors/saleListingExtractor'),
  PRICE_DROP:           () => import('./extractors/saleListingExtractor'),
  OFF_MARKET_SALE:      () => import('./extractors/saleListingExtractor'),
  RENTAL_LISTING:       () => import('./extractors/rentalListingExtractor'),
  COMING_SOON_SALE:     () => import('./extractors/comingSoonExtractor'),
  COMING_SOON_RENTAL:   () => import('./extractors/comingSoonExtractor'),
  BUYER_ISO:            () => import('./extractors/buyerISOExtractor'),
  RENTER_INQUIRY:       () => import('./extractors/renterInquiryExtractor'),
  SELLER_LEAD:          () => import('./extractors/sellerLeadExtractor'),
  LANDLORD_LEAD:        () => import('./extractors/landlordLeadExtractor'),
  DEVELOPMENT_INVENTORY:     () => import('./extractors/newDevExtractor'),
  COMING_SOON_DEVELOPMENT:   () => import('./extractors/newDevExtractor'),
  SPONSOR_UNIT:              () => import('./extractors/newDevExtractor'),
  SHOWING_CONFIRMATION: () => import('./extractors/showingConfirmationExtractor'),
  OPEN_HOUSE:           () => import('./extractors/saleListingExtractor'),
  MARKET_REPORT:        () => import('./extractors/marketReportExtractor'),
  REAL_ESTATE_EVENT:    () => import('./extractors/marketReportExtractor'),
  CLIENT_CONVERSATION:  () => import('./extractors/clientConversationExtractor'),
}

export async function routeToExtractor(
  category: string,
  input: ExtractorInput
): Promise<ExtractionResult[]> {
  const loader = EXTRACTOR_MAP[category]
  if (!loader) {
    // Unknown category — fall back to noise
    const { noiseHandler } = await import('./extractors/noiseHandler')
    return noiseHandler(input)
  }

  const mod = await loader()
  const fn: ExtractorFn | undefined = mod.default ?? mod.extract
  if (!fn) {
    const { noiseHandler } = await import('./extractors/noiseHandler')
    return noiseHandler(input)
  }

  return fn(input)
}
