import type { ListingData, BuyerData, FeatureResult } from '../scorerTypes'
import { isAbsenteeOwner } from '../absentee'
import { listingPropertyClass } from '../propertyTypes'

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000

interface SituationProfile {
  hasDistress: boolean
  distressLevel: string | null
  isHighEquity: boolean
  isAbsentee: boolean
  isMultifamily: boolean
  isVacant: boolean
  longTenure: boolean
  isSFH: boolean
  isCondoCoop: boolean
  isExpired: boolean
  price: number | null
}

function profileOf(listing: ListingData, now: Date): SituationProfile {
  const status = listing.preForeclosureStatus
  const hasDistress = status === 'LIS_PENDENS' || status === 'NOTICE_OF_DEFAULT' || status === 'AUCTION_SCHEDULED'
  const isHighEquity =
    listing.equityBalance != null &&
    listing.estimatedValue != null &&
    listing.estimatedValue > 0 &&
    listing.equityBalance / listing.estimatedValue >= 0.5
  // Brief 41: the shared absentee test (ownerOccupied first, then normalised
  // streets) and the shared property-type vocabulary, so this feature agrees with
  // absenteeOwner and propertyType.
  const isAbsentee = isAbsenteeOwner(listing) === true
  const cls = listingPropertyClass(listing)
  const isMultifamily = (listing.unitCount ?? 0) >= 2 || cls === 'multifamily'
  const isCondoCoop = !isMultifamily && (cls === 'condo' || cls === 'coop')
  const isSFH = !isMultifamily && (cls === 'single_family' || cls === 'townhouse')
  const longTenure = listing.lastSaleDate != null && (now.getTime() - listing.lastSaleDate.getTime()) / MS_PER_YEAR >= 10
  return {
    hasDistress,
    distressLevel: status,
    isHighEquity,
    isAbsentee,
    isMultifamily,
    isVacant: listing.isVacant === true,
    longTenure,
    isSFH,
    isCondoCoop,
    isExpired: listing.priorListingStatus === 'EXPIRED',
    price: listing.price,
  }
}

// Maps (buyer archetype × listing situation) → fit. See brief's compatibility
// table. null/unknown archetype → 0.7 LOW abstain.
export function computeBuyerArchetypeSituation(listing: ListingData, buyer: BuyerData): FeatureResult {
  const key = 'buyerArchetypeSituation'
  const arch = buyer.buyerArchetype
  if (arch == null) return { key, score: 0.7, confidence: 'LOW' }
  // longTenure is the only now-dependent field; the archetype feature isn't handed
  // the ScoringContext, so it reads the wall clock directly (all required test cases
  // are now-independent).
  const prof = profileOf(listing, new Date())

  const HIGH = 'HIGH' as const
  const mk = (score: number): FeatureResult => ({ key, score, confidence: HIGH })

  switch (arch) {
    case 'CASH_BUYER':
      if (prof.hasDistress) return mk(1.0)
      if (prof.isHighEquity && prof.isAbsentee) return mk(0.9)
      return mk(0.7)

    case 'EXCHANGE_1031':
      if (prof.isExpired) return mk(0.9)
      if (prof.hasDistress) return mk(0.5) // timing risk on a 1031 clock
      return mk(0.7)

    case 'TRADITIONAL_FINANCING':
      if (prof.hasDistress) return mk(0.3) // financing timeline vs distress mismatch
      if (prof.isHighEquity && prof.longTenure) return mk(0.95)
      return mk(0.7)

    case 'INVESTOR_LANDLORD':
      if (prof.isMultifamily && prof.isAbsentee) return mk(1.0)
      if (prof.isMultifamily) return mk(0.85)
      if (prof.isCondoCoop) return mk(0.55)
      if (prof.isSFH) return mk(0.4)
      return mk(0.4)

    case 'FIRST_TIME_FHA':
      if (prof.hasDistress) return mk(0.2)
      if (prof.price != null && prof.price < 1_500_000) return mk(0.9)
      if (prof.price != null && prof.price >= 1_500_000) return mk(0.3)
      return mk(0.5)

    case 'LUXURY_ALL_CASH':
      if (prof.price == null) return mk(0.5)
      if (prof.price >= 5_000_000) return mk(1.0)
      if (prof.price >= 2_000_000) return mk(0.6)
      return mk(0.2)

    case 'LUXURY_FINANCED': {
      // Same price tiers as LUXURY_ALL_CASH, minus the distress affinity (a
      // financed luxury buyer can't chase a foreclosure clock).
      if (prof.price == null) return mk(0.5)
      let base = prof.price >= 5_000_000 ? 1.0 : prof.price >= 2_000_000 ? 0.6 : 0.2
      if (prof.hasDistress) base = Math.min(base, 0.5)
      return mk(base)
    }

    default:
      return mk(0.7) // recognized-but-unmapped archetype string
  }
}
