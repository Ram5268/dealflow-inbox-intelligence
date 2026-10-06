// Phase A — single source of truth for category groupings.
// Pure addition; no existing file imports this yet.
//
// Union of:
//   - prisma/schema.prisma Category enum (20 values)
//   - lib/retrieval/queryPlanner.ts SUPPLY_* / DEMAND_ALL / LEAD_ALL / PREMARKET_CATS / SALE_CATS_FOR_FILTER / RENTAL_CATS_FOR_FILTER
//   - lib/ingestion/validator.ts SUPPLY_SIDE / LOW_RISK
//   - lib/matchmaking.ts SALE_CATEGORIES / RENTAL_CATEGORIES
//   - app/api/opportunities/[id]/route.ts SE_LISTABLE
//
// Every value of `Category` must appear in exactly one of SUPPLY_SALE /
// SUPPLY_RENTAL / DEMAND_BUYER / DEMAND_RENTER / LEAD_SELLER /
// LEAD_LANDLORD / INFORMATIONAL, or be the explicit NOISE sentinel.
// The compile-time check at the bottom of this file enforces that.

import { Category } from '@prisma/client'

// ── Supply side ──────────────────────────────────────────────────────────────
// Real on-market or pre-market sale inventory. Source-of-truth for "is this a
// sale-side listing" — supersedes the inline sale arrays in queryPlanner.ts
// (SUPPLY_SALE_ACTIVE + SUPPLY_SALE_PREMARKET) and matchmaking.ts (SALE_CATEGORIES).
export const SUPPLY_SALE = [
  Category.ACTIVE_SALE_LISTING,
  Category.OFF_MARKET_SALE,
  Category.COMING_SOON_SALE,
  Category.PRICE_DROP,
  Category.BACK_ON_MARKET,
  Category.DEVELOPMENT_INVENTORY,
  Category.SPONSOR_UNIT,
  Category.COMING_SOON_DEVELOPMENT,
] as const satisfies readonly Category[]

// Real on-market or pre-market rental inventory.
// Supersedes SUPPLY_RENTAL in queryPlanner.ts and RENTAL_CATEGORIES in matchmaking.ts.
export const SUPPLY_RENTAL = [
  Category.RENTAL_LISTING,
  Category.COMING_SOON_RENTAL,
] as const satisfies readonly Category[]

// ── Demand side ──────────────────────────────────────────────────────────────
// Per DEALFLOW_AI.md these are OTHER agents' clients (co-broke opportunities).
// Split into two so callers can ask about buyer-side vs renter-side demand
// independently — the existing DEMAND_ALL in queryPlanner.ts is just the union.
export const DEMAND_BUYER  = [Category.BUYER_ISO]      as const satisfies readonly Category[]
export const DEMAND_RENTER = [Category.RENTER_INQUIRY] as const satisfies readonly Category[]

// ── Lead side ────────────────────────────────────────────────────────────────
// Potential listings (sale or landlord). LEAD_ALL in queryPlanner.ts is the union.
export const LEAD_SELLER   = [Category.SELLER_LEAD]   as const satisfies readonly Category[]
export const LEAD_LANDLORD = [Category.LANDLORD_LEAD] as const satisfies readonly Category[]

// ── Informational ────────────────────────────────────────────────────────────
// Not inventory, not demand, not a lead. Events, reports, conversations,
// confirmed showings (the showing itself is informational; the underlying
// listing that the showing references stays in SUPPLY_*).
export const INFORMATIONAL = [
  Category.OPEN_HOUSE,
  Category.MARKET_REPORT,
  Category.REAL_ESTATE_EVENT,
  Category.CLIENT_CONVERSATION,
  Category.SHOWING_CONFIRMATION,
] as const satisfies readonly Category[]

// ── StreetEasy lookup-eligible categories ───────────────────────────────────
// Copied verbatim from app/api/opportunities/[id]/route.ts:5. These are the
// categories worth a live SE API call when we don't have a streetEasyId cached.
// Used by POST /api/opportunities/[id]/streeteasy, which runs only when asked
// (Brief 41: opening a listing no longer triggers a lookup).
export const SE_LISTABLE: ReadonlySet<Category> = new Set<Category>([
  Category.ACTIVE_SALE_LISTING,
  Category.COMING_SOON_SALE,
  Category.OFF_MARKET_SALE,
  Category.RENTAL_LISTING,
  Category.COMING_SOON_RENTAL,
  Category.DEVELOPMENT_INVENTORY,
  Category.SPONSOR_UNIT,
  Category.PRICE_DROP,
  Category.BACK_ON_MARKET,
  Category.OPEN_HOUSE,
  Category.SHOWING_CONFIRMATION,
  Category.COMING_SOON_DEVELOPMENT,
])

// ── Predicates ───────────────────────────────────────────────────────────────
const SUPPLY_SALE_SET    = new Set<Category>(SUPPLY_SALE)
const SUPPLY_RENTAL_SET  = new Set<Category>(SUPPLY_RENTAL)
const DEMAND_BUYER_SET   = new Set<Category>(DEMAND_BUYER)
const DEMAND_RENTER_SET  = new Set<Category>(DEMAND_RENTER)
const LEAD_SELLER_SET    = new Set<Category>(LEAD_SELLER)
const LEAD_LANDLORD_SET  = new Set<Category>(LEAD_LANDLORD)
const INFORMATIONAL_SET  = new Set<Category>(INFORMATIONAL)

export function isRental(c: Category): boolean {
  return SUPPLY_RENTAL_SET.has(c) || DEMAND_RENTER_SET.has(c)
}

export function isSale(c: Category): boolean {
  return SUPPLY_SALE_SET.has(c) || DEMAND_BUYER_SET.has(c)
}

export function isSupply(c: Category): boolean {
  return SUPPLY_SALE_SET.has(c) || SUPPLY_RENTAL_SET.has(c)
}

export function isDemand(c: Category): boolean {
  return DEMAND_BUYER_SET.has(c) || DEMAND_RENTER_SET.has(c)
}

export function isLead(c: Category): boolean {
  return LEAD_SELLER_SET.has(c) || LEAD_LANDLORD_SET.has(c)
}

export function isInformational(c: Category): boolean {
  return INFORMATIONAL_SET.has(c)
}

// ── Exhaustiveness check (compile-time) ──────────────────────────────────────
// Every Category enum value must be classified into exactly one bucket above
// (or be NOISE). Adding a new enum value without updating this file will
// produce a TypeScript error on the line below.
type _Classified =
  | typeof SUPPLY_SALE[number]
  | typeof SUPPLY_RENTAL[number]
  | typeof DEMAND_BUYER[number]
  | typeof DEMAND_RENTER[number]
  | typeof LEAD_SELLER[number]
  | typeof LEAD_LANDLORD[number]
  | typeof INFORMATIONAL[number]
  | typeof Category.NOISE

// If `Category` ever contains a value not in `_Classified`, this assignment fails to compile.
const _exhaustive: _Classified extends Category ? Category extends _Classified ? true : never : never = true
void _exhaustive
