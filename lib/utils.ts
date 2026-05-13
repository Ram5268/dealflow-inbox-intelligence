import { Category, TransactionType } from '@prisma/client'

export const CATEGORY_LABELS: Record<Category, string> = {
  COMING_SOON_SALE: 'Coming Soon',
  OFF_MARKET_SALE: 'Off Market',
  ACTIVE_SALE_LISTING: 'Active Listing',
  RENTAL_LISTING: 'Rental',
  BUYER_ISO: 'Buyer ISO',
  RENTER_INQUIRY: 'Renter Inquiry',
  SELLER_LEAD: 'Seller Lead',
  LANDLORD_LEAD: 'Landlord Lead',
  DEVELOPMENT_INVENTORY: 'New Development',
  OPEN_HOUSE: 'Open House',
  PRICE_DROP: 'Price Drop',
  BACK_ON_MARKET: 'Back on Market',
  NOISE: 'Noise',
}

export const CATEGORY_COLORS: Record<Category, string> = {
  COMING_SOON_SALE: 'bg-purple-100 text-purple-800',
  OFF_MARKET_SALE: 'bg-indigo-100 text-indigo-800',
  ACTIVE_SALE_LISTING: 'bg-green-100 text-green-800',
  RENTAL_LISTING: 'bg-blue-100 text-blue-800',
  BUYER_ISO: 'bg-orange-100 text-orange-800',
  RENTER_INQUIRY: 'bg-cyan-100 text-cyan-800',
  SELLER_LEAD: 'bg-rose-100 text-rose-800',
  LANDLORD_LEAD: 'bg-amber-100 text-amber-800',
  DEVELOPMENT_INVENTORY: 'bg-teal-100 text-teal-800',
  OPEN_HOUSE: 'bg-lime-100 text-lime-800',
  PRICE_DROP: 'bg-red-100 text-red-800',
  BACK_ON_MARKET: 'bg-yellow-100 text-yellow-800',
  NOISE: 'bg-gray-100 text-gray-500',
}

export const TRANSACTION_LABELS: Record<TransactionType, string> = {
  SALE: 'For Sale',
  RENTAL: 'For Rent',
  BUYER_NEED: 'Buyer Need',
  RENTER_NEED: 'Renter Need',
  SELLER_LEAD: 'Seller Lead',
  LANDLORD_LEAD: 'Landlord Lead',
  UNKNOWN: 'Unknown',
}

export function formatPrice(price: number | null | undefined): string {
  if (price == null) return '—'
  if (price >= 1_000_000) return `$${(price / 1_000_000).toFixed(2)}M`
  if (price >= 1_000) return `$${(price / 1_000).toFixed(0)}K`
  return `$${price.toLocaleString()}`
}

export function formatPriceRange(
  min: number | null | undefined,
  max: number | null | undefined,
  price: number | null | undefined
): string {
  if (price != null) return formatPrice(price)
  if (min != null && max != null) return `${formatPrice(min)} – ${formatPrice(max)}`
  if (min != null) return `${formatPrice(min)}+`
  if (max != null) return `Up to ${formatPrice(max)}`
  return '—'
}

export function timeAgo(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

export function confidenceLabel(score: number): string {
  if (score >= 0.85) return 'High'
  if (score >= 0.6) return 'Medium'
  return 'Low'
}

export function confidenceColor(score: number): string {
  if (score >= 0.85) return 'text-green-600'
  if (score >= 0.6) return 'text-yellow-600'
  return 'text-red-500'
}
