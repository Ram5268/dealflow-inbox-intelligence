import type { ListingData, BuyerData, FeatureResult } from '../scorerTypes'
import { isAbsenteeOwner } from '../absentee'
import { listingPropertyClasses } from '../propertyTypes'
import { chancePriceUnder, sellerPrice } from '../sellerPrice'

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
  ourValue: number | null // Brief 44 (PR 4): price is our own value: read as a chance (below)
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
  const cls = listingPropertyClasses(listing)
  const isMultifamily = (listing.unitCount ?? 0) >= 2 || cls.has('multifamily') // 2+ units, as before
  const isCondoCoop = !isMultifamily && (cls.has('condo') || cls.has('coop'))
  const isSFH = !isMultifamily && (cls.has('single_family') || cls.has('townhouse'))
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
    ourValue: listing.ourEstimate === true ? ourValueOf(listing) : null,
  }
}

// Brief 44 (PR 4): a CRM seller priced by our own published value (ourEstimates.ts) isn't
// held to the $1.5M / $2M / $5M lines as if that value were an exact price. It scores
// what the lines would give on average over how real prices spread around our estimates
// (sellerPrice.ts): each side's score weighted by the chance the real price lands there.
// An asking or last asking price, and any other estimate, keep the exact lines. (Brief 44
// §6's design, an engineering choice, as PR #14 made for the price fit.)
function ourValueOf(listing: ListingData): number | null {
  const sp = sellerPrice(listing)
  return sp?.basis === 'estimate' ? sp.price : null
}

function firstTimeChance(value: number): number {
  const under = chancePriceUnder(value, 1_500_000)
  return 0.9 * under + 0.3 * (1 - under)
}

function luxuryChance(value: number): number {
  const under2m = chancePriceUnder(value, 2_000_000)
  const under5m = chancePriceUnder(value, 5_000_000)
  return 1.0 * (1 - under5m) + 0.6 * (under5m - under2m) + 0.2 * under2m
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
      if (prof.ourValue != null) return mk(firstTimeChance(prof.ourValue))
      if (prof.price != null && prof.price < 1_500_000) return mk(0.9)
      if (prof.price != null && prof.price >= 1_500_000) return mk(0.3)
      return mk(0.5)

    case 'LUXURY_ALL_CASH':
      if (prof.ourValue != null) return mk(luxuryChance(prof.ourValue))
      if (prof.price == null) return mk(0.5)
      if (prof.price >= 5_000_000) return mk(1.0)
      if (prof.price >= 2_000_000) return mk(0.6)
      return mk(0.2)

    case 'LUXURY_FINANCED': {
      // Same price tiers as LUXURY_ALL_CASH, minus the distress affinity (a
      // financed luxury buyer can't chase a foreclosure clock).
      if (prof.price == null) return mk(0.5)
      let base = prof.ourValue != null ? luxuryChance(prof.ourValue) : prof.price >= 5_000_000 ? 1.0 : prof.price >= 2_000_000 ? 0.6 : 0.2
      if (prof.hasDistress) base = Math.min(base, 0.5)
      return mk(base)
    }

    default:
      return mk(0.7) // recognized-but-unmapped archetype string
  }
}
