import type { CrmFieldValue, CrmLeadRow } from './crmReader'

// Brief 48 (PR 9, item 4.10): seller details the CRM holds, copied into the columns
// DealFlow's matching and call list already read. Until now the copy brought none of them,
// so six motivation factors (preForeclosure, foreclosureUrgency, vacancy, highEquity,
// freeAndClear, goldenHandcuff: lib/matching/features) abstained for every CRM seller,
// and the listing-status rules (eligibility's "currently listed", an expired listing's
// last asking price: sellerPrice.ts) never applied.
//
// What the CRM stores (its schema, look-only, CRM main 1b9d661): the Lead has no column
// for any of these. They exist only as custom fields: a Mojo upload's columns become
// CustomFieldDefinitions by their header (src/lib/core-data/importer/ai-mapping.ts,
// commit-worker.ts), and the copy already reads every lead custom field by definition
// name (crmReader.ts). So each DealFlow column below is read from the first of its
// accepted field names that the lead has a value for (case, spaces and punctuation
// ignored), and only an unambiguous value is copied; anything else stays blank
// [engineering precaution: a wrong distress or listing fact is worse than none]. A CRM
// with none of these fields changes nothing. Not copied, with why:
//   - estimated value: it is a price, and matching's prices are DealFlow's own values or
//     a last asking price (Ryan, 2026-10-02 and 2026-10-17); highEquity reads DealFlow's
//     value as the estimate when the USE_OUR_ESTIMATES switch is on;
//   - phone types: ContactPhone.type is 'mobile' for every number of an upload without a
//     phone-type column (importer dedup.ts normalizePhoneType), so it can't tell a real
//     mobile from a default, and ContactPhone.lineType is written by nothing in the CRM;
//   - listing brokerage and days on market: matching doesn't read them (the brokerage
//     would reach buyer-facing text: supplyResolver.ts).
// Tags are only ever added to, never removed [engineering precaution: a tag can mean do
// not call to the call list's hard filter]; the scalars follow PR 7's rules (upsert.ts,
// crmWins.ts).

export const DETAIL_COLUMNS = [
  'priorListingStatus', 'priorListingPrice', 'preForeclosureStatus', 'foreclosureAuctionDate',
  'isVacant', 'equityBalance', 'totalLoanBalance', 'loanInterestRate', 'tags',
] as const
export type DetailColumn = (typeof DETAIL_COLUMNS)[number]

// Accepted CRM field names per column, best first, as normName gives them. Generic names
// ("Status", "Rate", "Sale Date", "Loan Amount", "Equity %") are left out on purpose: they
// can mean something else.
export const DETAIL_FIELDS: Record<DetailColumn, readonly string[]> = {
  priorListingStatus: ['listing status', 'mls status', 'last listing status', 'prior listing status'],
  priorListingPrice: ['list price', 'listing price', 'last list price', 'last listing price'],
  preForeclosureStatus: ['pre foreclosure status', 'preforeclosure status', 'foreclosure status', 'pre foreclosure', 'preforeclosure'],
  foreclosureAuctionDate: ['auction date', 'foreclosure auction date', 'foreclosure sale date'],
  isVacant: ['vacant', 'vacancy', 'is vacant', 'vacant property', 'property vacant'],
  equityBalance: ['equity', 'estimated equity', 'equity balance', 'est equity', 'available equity'],
  totalLoanBalance: ['loan balance', 'total loan balance', 'mortgage balance', 'open mortgage balance', 'estimated mortgage balance', 'total mortgage balance'],
  loanInterestRate: ['interest rate', 'loan interest rate', 'mortgage interest rate', 'mortgage rate'],
  tags: ['tags', 'tag', 'mojo tags', 'lead tags'],
}

type Fields = CrmLeadRow['fields']
// "Equity %" is a share, not an amount: % is kept as a word so it never reads as "Equity".
export const normName = (s: string) => s.toLowerCase().replace(/%/g, ' percent ').replace(/[^a-z0-9]+/g, ' ').trim()
const filled = (v: CrmFieldValue | undefined) => !!v && ((v.t ?? '').trim() !== '' || v.n != null || v.d != null)

// The lead's field this column is read from: the first accepted name with a value.
export function detailField(fields: Fields, column: DetailColumn): { name: string; value: CrmFieldValue } | null {
  const byName = new Map<string, string[]>()
  for (const k of Object.keys(fields)) byName.set(normName(k), [...(byName.get(normName(k)) ?? []), k])
  for (const accepted of DETAIL_FIELDS[column]) {
    for (const k of byName.get(accepted) ?? []) if (filled(fields[k])) return { name: k, value: fields[k] }
  }
  return null
}

const words = (v: string | null | undefined) => ` ${normName(v ?? '')} `
const has = (s: string, ...ws: string[]) => ws.some(w => s.includes(` ${w} `))

// DealFlow's listing statuses (MojoContact.priorListingStatus). Still on the market in any
// form (pending, in contract, coming soon) counts as ACTIVE, which matching leaves alone
// (REBNY: eligibility.ts); taken off without selling (withdrawn, cancelled, temporarily off
// the market) as WITHDRAWN.
export function listingStatusOf(raw: string | null | undefined): string | null {
  const s = words(raw)
  if (has(s, 'expired')) return 'EXPIRED'
  if (has(s, 'withdrawn', 'cancelled', 'canceled', 'terminated') || s.includes(' temporarily off market ') || s.includes(' temp off market ')) return 'WITHDRAWN'
  if (has(s, 'active', 'pending', 'contingent', 'coming soon') || s.includes(' under contract ') || s.includes(' in contract ')) return 'ACTIVE'
  if (has(s, 'sold', 'closed')) return 'SOLD'
  if (s.includes(' never listed ') || s.includes(' not listed ')) return 'NEVER_LISTED'
  return null
}

// DealFlow's pre-foreclosure stages (preForeclosure.ts). A plain yes is a lis pendens: New
// York forecloses through the courts, so a pre-foreclosure record there starts with one
// [engineering judgment]; a plain no is NONE, a known negative.
export function preForeclosureOf(raw: string | null | undefined): string | null {
  const s = words(raw)
  if (has(s, 'auction')) return 'AUCTION_SCHEDULED'
  if (s.includes(' lis pendens ') || has(s, 'lp')) return 'LIS_PENDENS'
  if (s.includes(' notice of default ') || has(s, 'nod', 'default')) return 'NOTICE_OF_DEFAULT'
  if (has(s, 'no', 'none', 'false', 'n')) return 'NONE'
  if (has(s, 'yes', 'y', 'true')) return 'LIS_PENDENS'
  return null
}

export function yesNo(v: CrmFieldValue | undefined): boolean | null {
  if (!v) return null
  if (v.n === 1) return true
  if (v.n === 0) return false
  const s = normName(v.t ?? '')
  if (['yes', 'y', 'true', '1', 'vacant'].includes(s)) return true
  if (['no', 'n', 'false', '0', 'occupied', 'not vacant'].includes(s)) return false
  return null
}

// A dollar amount: a number, or text like "$1,250,000" (no percentages, no words).
export function money(v: CrmFieldValue | undefined): number | null {
  if (!v) return null
  if (v.n != null) return Number.isFinite(v.n) ? v.n : null
  const s = (v.t ?? '').replace(/[$,\s]/g, '')
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null
}

// An interest rate in percent ("3.75%" or 3.75). Outside 1-25 it may be a fraction or a
// typo, so it's left blank.
export function rateOf(v: CrmFieldValue | undefined): number | null {
  if (!v) return null
  const s = v.n != null ? String(v.n) : (v.t ?? '').replace(/[%\s]/g, '')
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const r = Number(s)
  return r >= 1 && r <= 25 ? r : null
}

// A date as the copy's other dates travel ("YYYY-MM-DD HH:MM:SS", New York wall clock as
// the CRM stores it): a date field, or text as 12/01/2026 or 2026-12-01.
export function dateOf(v: CrmFieldValue | undefined): string | null {
  if (!v) return null
  if (v.d) return v.d
  const s = (v.t ?? '').trim()
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  const [y, m, d] = us ? [+us[3], +us[1], +us[2]] : iso ? [+iso[1], +iso[2], +iso[3]] : [0, 0, 0]
  if (!y) return null
  const day = new Date(Date.UTC(y, m - 1, d))
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} 00:00:00`
}

export function tagsOf(v: CrmFieldValue | undefined): string[] | null {
  const tags = [...new Set((v?.t ?? '').split(/[,;|]/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean))]
  return tags.length > 0 ? tags : null
}

const atLeast = (min: number, x: number | null) => (x != null && x >= min ? x : null)

// The details for mapLead. Equity may be below zero (owing more than the home is worth); a
// loan balance of 0 means free and clear; an asking price must be above 0.
export function sellerDetails(fields: Fields) {
  const v = (c: DetailColumn) => detailField(fields, c)?.value
  return {
    priorListingStatus: listingStatusOf(v('priorListingStatus')?.t),
    priorListingPrice: atLeast(1, money(v('priorListingPrice'))),
    preForeclosureStatus: preForeclosureOf(v('preForeclosureStatus')?.t),
    foreclosureAuctionDate: dateOf(v('foreclosureAuctionDate')),
    isVacant: yesNo(v('isVacant')),
    equityBalance: money(v('equityBalance')),
    totalLoanBalance: atLeast(0, money(v('totalLoanBalance'))),
    loanInterestRate: rateOf(v('loanInterestRate')),
    tags: tagsOf(v('tags')),
  }
}
