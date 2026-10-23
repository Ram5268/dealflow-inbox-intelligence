// Brief 43 PR 14 (Q29, M21): the createdAfter filter shared by search_listings
// and search_parties: only items DealFlow added on or after a date, so "what
// came in today / this week" is a real date filter. Drift reads today's date
// from the TODAY line in its per-turn context (lib/chat/context/today.ts).
// Only an ISO date or date-time is accepted ("friday at 3" would otherwise
// parse as a date in 2001); a date alone means midnight in New York
// [engineering precaution].
import { z } from 'zod'
import { startOfNewYorkDay } from '../../time/newYork'

const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

// Midnight in New York on that day (05:00Z in winter, 04:00Z in summer), via
// Brief 48's lib/time/newYork.ts: noon UTC is the same calendar day in New York.
function newYorkMidnight(y: number, m: number, d: number): Date {
  return startOfNewYorkDay(new Date(Date.UTC(y, m - 1, d, 12)))
}

export function createdAfterDate(value: string): Date {
  const day = DATE_ONLY.exec(value)
  if (day) return newYorkMidnight(Number(day[1]), Number(day[2]), Number(day[3]))
  return new Date(value)
}

function isRealDate(value: string): boolean {
  const day = DATE_ONLY.exec(value.slice(0, 10))
  if (!day) return false
  const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])]
  const check = new Date(Date.UTC(y, m - 1, d))
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d && !Number.isNaN(createdAfterDate(value).getTime())
}

export const createdAfterSchema = z.string().max(40).regex(ISO).refine(isRealDate, 'createdAfter must be a real date')

// The where-clause piece: { createdAt: { gte } }, or nothing when not asked.
export function createdAfterWhere(value: string | undefined): { createdAt?: { gte: Date } } {
  return value ? { createdAt: { gte: createdAfterDate(value) } } : {}
}

export const CREATED_AFTER_DESCRIPTION =
  'Only items DealFlow added on or after this date: an ISO date ("2026-10-19") or date-time. A date alone means midnight in New York. ' +
  'Use it for "today", "this week", "the last 24 hours", counting back from the TODAY line in your context. ' +
  'While email reading is paused (the EMAIL note), nothing new comes in from email, so say so rather than calling older items new.'
