// Brief 45 (PR E): made-up data for scoreImport.integration.test.ts, written
// straight into two test databases: DealFlow's (DATABASE_URL) and a CRM one
// (CRM_TEST_DATABASE_URL). Fictional names ("Test Owner s12"), streets
// ("112 Example St"), 555-01xx phones and example.com addresses only. Each
// side gets its own organization (slug dealflow-ryan, id b45e_…), so cleanup
// is one organization's rows. Not a *.test.ts file.
import { createHash, randomBytes } from 'crypto'
import type { Client } from 'pg'
import { mapLead } from '../../crm-sync/mapLead'
import type { CrmLeadRow } from '../../crm-sync/crmReader'

export const P = 'b45e_'
export const DF_ORG = `${P}org`
export const CRM_ORG = `${P}crmorg`
export const IMPORT_OK = `${P}imp_ok`
export const IMPORT_EXPIRED = `${P}imp_expired`
export const IMPORT_RUNNING = `${P}imp_running`

export interface Sizes { sellers: number; isoBuyers: number; mojoBuyers: number; newLeads: number; noMojo: number; merged: number }

// A small deterministic generator, so every run seeds the same people.
export function rng(seed = 45) {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
}
type Rand = ReturnType<typeof rng>
const pick = <T>(r: Rand, xs: T[]): T => xs[Math.floor(r() * xs.length)]

const ZIPS = ['11216', '11221', '11233', '11238', '11213', '11225', '11226', '11203', '11205', '11206']
const TYPES = ['Duplex', 'Triplex', 'Quadruplex', 'Single Family Residential']
const HOODS = ['Crown Heights', 'Bedford-Stuyvesant', 'Bushwick', 'Prospect Heights', 'Flatbush', 'East Flatbush', 'Fort Greene', 'Williamsburg']
const FIELDS = ['Property City', 'Property State', 'Property Zip Code', 'Property Type', 'Bedrooms', 'Bathrooms', 'Last Call Result']

interface Person { id: string; mojoId: string | null; zip: string; type: string; beds: number; baths: number; street: string; ageMin: number; source: string | null }

function person(r: Rand, id: string, mojoId: string | null, n: number, ageMin: number, source: string | null): Person {
  return { id, mojoId, zip: pick(r, ZIPS), type: pick(r, TYPES), beds: 2 + Math.floor(r() * 7), baths: 1 + Math.floor(r() * 3), street: `${100 + n} Example St`, ageMin, source }
}

// The CRM read's row for a person, as crmReader returns it (used to seed
// DealFlow's existing copy exactly as the nightly lead copy would).
function crmRow(p: Person): CrmLeadRow {
  const f = (t: string | null, n: number | null = null) => ({ t, n, d: null })
  return {
    id: p.id, mojoId: p.mojoId ?? '', name: `Test Owner ${p.id.slice(P.length)}`, displayName: `Test Owner ${p.id.slice(P.length)}`,
    primaryAddressFull: `${p.street}, Brooklyn, NY ${p.zip}`, updatedAt: '2026-10-01 12:00:00', contactName: null,
    phones: ['+17185550150'], emails: [],
    fields: {
      'Property City': f('Brooklyn'), 'Property State': f('NY'), 'Property Zip Code': f(p.zip), 'Property Type': f(p.type),
      Bedrooms: f(null, p.beds), Bathrooms: f(null, p.baths), 'Last Call Result': f('No Answer'),
    },
  }
}

export interface Seeded {
  token: string
  existing: Person[]
  newLeads: Person[]
  noMojo: Person[]
  merged: Person[]
  requestIds: string[] // every lead id the CRM would send for IMPORT_OK
  preCopied: string // the new lead whose earlier copy already sits in DealFlow
}

export async function cleanup(df: Client, crm: Client) {
  for (const t of ['Match', 'CallQueueEntry', 'AuditLog', 'ExtractedOpportunity', 'RawEmail', 'MojoContact']) {
    await df.query(`DELETE FROM "${t}" WHERE "organizationId" = $1`, [DF_ORG])
  }
  await df.query(`DELETE FROM "MatchDismissal" WHERE starts_with("partyId", $1) OR starts_with("listingId", $1)`, [P])
  await df.query(`DELETE FROM "Organization" WHERE id = $1`, [DF_ORG])
  for (const t of ['CustomFieldValue', 'Contact', 'Lead', 'CustomFieldDefinition', 'ImportBatch']) {
    await crm.query(`DELETE FROM "${t}" WHERE "organizationId" = $1`, [CRM_ORG]) // phones go with their contact
  }
  await crm.query(`DELETE FROM "Organization" WHERE id = $1`, [CRM_ORG])
}

const UTC_NOW = `(now() AT TIME ZONE 'UTC')` // how the CRM (Prisma) stores time: UTC wall clock

export async function seed(df: Client, crm: Client, sizes: Sizes): Promise<Seeded> {
  const r = rng()
  const token = randomBytes(32).toString('base64url')
  const existing = Array.from({ length: sizes.sellers }, (_, i) => person(r, `${P}lead_s${i}`, `${P}m_s${i}`, i, 60 * 24 * 30, null))
  const newLeads = Array.from({ length: sizes.newLeads }, (_, i) => person(r, `${P}lead_n${i}`, `${P}m_n${i}`, 5000 + i, 9, `import:${IMPORT_OK}`))
  const noMojo = Array.from({ length: sizes.noMojo }, (_, i) => person(r, `${P}lead_x${i}`, null, 7000 + i, 9, `import:${IMPORT_OK}`))
  // Already in the CRM; the upload merged into them and re-stamped the source.
  const merged = Array.from({ length: sizes.merged }, (_, i) => person(r, `${P}lead_g${i}`, `${P}m_g${i}`, 8000 + i, 60 * 24 * 20, `import:${IMPORT_OK}`))
  const everyone = [...existing, ...newLeads, ...noMojo, ...merged]

  // ── CRM ──
  await crm.query(`INSERT INTO "Organization" (id, slug, name) VALUES ($1, 'dealflow-ryan', 'Test organization')`, [CRM_ORG])
  await crm.query(`INSERT INTO "ImportBatch" (id, "organizationId", "userId", "sourceLabel", filename, "storageKey", status, "createdAt", "completedAt", "dealflowScoreTokenHash")
    SELECT b.id, $1, 'b45e_user', 'Test upload', 'test.csv', 'none', b.status, ${UTC_NOW} - make_interval(mins => b.created), ${UTC_NOW} - make_interval(mins => b.done), $2
    FROM (VALUES ($3, 'completed', 10, 5), ($4, 'completed', 70, 61), ($5, 'importing', 3, 0)) AS b(id, status, created, done)`,
  [CRM_ORG, createHash('sha256').update(token).digest('hex'), IMPORT_OK, IMPORT_EXPIRED, IMPORT_RUNNING])
  await crm.query(`INSERT INTO "CustomFieldDefinition" (id, "organizationId", "objectType", name, type, "displayOrder", "updatedAt")
    SELECT $1 || i, $2, 'lead', name, 'text', i, now() FROM unnest($3::text[]) WITH ORDINALITY AS d(name, i)`, [`${P}cfd_`, CRM_ORG, FIELDS])
  await crm.query(`INSERT INTO "Lead" (id, "organizationId", "displayName", name, source, "primaryAddressFull", "mojoId", "createdAt", "updatedAt")
    SELECT l.id, $2, l.name, l.name, l.source, l.address, l."mojoId", ${UTC_NOW} - make_interval(mins => l.age), now()
    FROM jsonb_to_recordset($1::jsonb) AS l(id text, name text, source text, address text, "mojoId" text, age int)`,
  [JSON.stringify(everyone.map(p => ({ id: p.id, name: crmRow(p).name, source: p.source, address: crmRow(p).primaryAddressFull, mojoId: p.mojoId, age: p.ageMin }))), CRM_ORG])
  await crm.query(`INSERT INTO "Contact" (id, "organizationId", "leadId", "displayName", "updatedAt")
    SELECT 'b45e_con_' || l.id, $2, l.id, 'Test contact', now() FROM unnest($1::text[]) AS l(id)`, [everyone.map(p => p.id), CRM_ORG])
  await crm.query(`INSERT INTO "ContactPhone" (id, "contactId", phone, type, "isPrimary", "updatedAt")
    SELECT 'b45e_ph_' || l.id, 'b45e_con_' || l.id, '+1718555' || lpad((100 + (n % 100))::text, 4, '0'), 'mobile', true, now()
    FROM unnest($1::text[]) WITH ORDINALITY AS l(id, n)`, [everyone.map(p => p.id)])
  const values = everyone.flatMap(p => Object.entries(crmRow(p).fields).map(([name, v]) => ({
    id: `${P}cfv_${p.id}_${FIELDS.indexOf(name) + 1}`, def: `${P}cfd_${FIELDS.indexOf(name) + 1}`, lead: p.id, t: v.t, n: v.n,
  })))
  await crm.query(`INSERT INTO "CustomFieldValue" (id, "organizationId", "definitionId", "objectType", "objectId", "valueText", "valueNumber")
    SELECT v.id, $2, v.def, 'lead', v.lead, v.t, v.n FROM jsonb_to_recordset($1::jsonb) AS v(id text, def text, lead text, t text, n float8)`,
  [JSON.stringify(values), CRM_ORG])

  // ── DealFlow ──
  await df.query(`INSERT INTO "Organization" (id, name, slug, "updatedAt") VALUES ($1, 'Test organization', 'dealflow-ryan', now())`, [DF_ORG])
  await df.query(`INSERT INTO "RawEmail" (id, "graphMessageId", subject, "receivedDateTime", "updatedAt", "organizationId")
    VALUES ('b45e_raw', 'b45e_graph', 'Test buyer requests', now(), now(), $1)`, [DF_ORG])
  const iso = Array.from({ length: sizes.isoBuyers }, (_, i) => {
    const min = 800_000 + Math.floor(r() * 12) * 100_000
    return {
      id: `${P}iso_${i}`, hoods: Array.from(new Set([pick(r, HOODS), pick(r, HOODS)])), types: [pick(r, ['Multi-Family', '2-Family', '3-Family', 'Townhouse'])],
      minBeds: 2 + Math.floor(r() * 2), maxBeds: 4 + Math.floor(r() * 3), minPrice: min, maxPrice: min + 1_500_000,
      arch: pick(r, ['CASH_BUYER', 'INVESTOR_LANDLORD', 'TRADITIONAL_FINANCING']), agent: `Test Agent ${i}`, email: `agent${i}@example.com`,
    }
  })
  await df.query(`INSERT INTO "ExtractedOpportunity" (id, "rawEmailId", category, "transactionType", neighborhoods, "propertyTypes", "minBeds", "maxBeds",
      "minPrice", "maxPrice", "buyerArchetype", "sourceAgentName", "sourceAgentEmail", "sourceBrokerage", "extractedTitle", "extractedSummary",
      "classificationReason", "confidenceScore", "isTestData", "updatedAt", "organizationId")
    SELECT b.id, 'b45e_raw', 'BUYER_ISO', 'BUYER_NEED', b.hoods, b.types, b."minBeds", b."maxBeds", b."minPrice", b."maxPrice", b.arch, b.agent, b.email,
      'Example Realty', 'Test buyer', 'Test buyer request', 'test', 0.9, false, now(), $2
    FROM jsonb_to_recordset($1::jsonb) AS b(id text, hoods text[], types text[], "minBeds" int, "maxBeds" int, "minPrice" float8, "maxPrice" float8,
      arch text, agent text, email text)`, [JSON.stringify(iso), DF_ORG])

  // Existing sellers, written as the nightly lead copy writes them; Mojo buyers.
  const sellerRows = existing.map(p => {
    const c = mapLead(crmRow(p))
    return {
      id: `${P}mc_${p.id.slice(P.length)}`, mojoId: c.mojoId, fullName: c.fullName, phone: c.phones[0] ?? null, address: c.address, city: c.city,
      state: c.state, zipCode: c.zipCode, neighborhood: c.neighborhood, propertyTypeDetail: c.propertyTypeDetail, unitCount: c.unitCount,
      propertyBeds: c.propertyBeds, propertyBaths: c.propertyBaths, status: c.status, metadata: c.metadata, intent: 'SELLER',
      bedsMin: null, bedsMax: null, budgetMin: null, budgetMax: null, cashOnly: null,
    }
  })
  const buyerRows = Array.from({ length: sizes.mojoBuyers }, (_, i) => ({
    id: `${P}mb_${i}`, mojoId: `${P}m_b${i}`, fullName: `Test Buyer ${i}`, phone: null, address: null, city: null, state: null, zipCode: null,
    neighborhood: pick(r, HOODS), propertyTypeDetail: null, unitCount: null, propertyBeds: null, propertyBaths: null, status: null, metadata: null,
    intent: 'BUYER', bedsMin: 2, bedsMax: 5, budgetMin: 900_000, budgetMax: 2_500_000, cashOnly: r() < 0.5,
  }))
  await df.query(`INSERT INTO "MojoContact" (id, "mojoId", "fullName", phone, address, city, state, "zipCode", neighborhood, "propertyTypeDetail",
      "unitCount", "propertyBeds", "propertyBaths", status, metadata, intent, "bedsMin", "bedsMax", "budgetMin", "budgetMax", "cashOnly",
      tags, groups, "isTestData", "updatedAt", "organizationId")
    SELECT c.id, c."mojoId", c."fullName", c.phone, c.address, c.city, c.state, c."zipCode", c.neighborhood, c."propertyTypeDetail", c."unitCount",
      c."propertyBeds", c."propertyBaths", c.status, c.metadata, c.intent, c."bedsMin", c."bedsMax", c."budgetMin", c."budgetMax", c."cashOnly",
      '{}', '{}', false, now(), $2
    FROM jsonb_to_recordset($1::jsonb) AS c(id text, "mojoId" text, "fullName" text, phone text, address text, city text, state text, "zipCode" text,
      neighborhood text, "propertyTypeDetail" text, "unitCount" int, "propertyBeds" float8, "propertyBaths" float8, status text, metadata jsonb,
      intent text, "bedsMin" int, "bedsMax" int, "budgetMin" float8, "budgetMax" float8, "cashOnly" boolean)`,
  [JSON.stringify([...sellerRows, ...buyerRows]), DF_ORG])

  // Every third existing seller has an older match, and the morning list
  // ranks them: both must come through the import untouched.
  const withMatch = sellerRows.filter((_, i) => i % 3 === 0)
  await df.query(`INSERT INTO "Match" (id, "opportunityId", "opportunityType", "counterpartId", "counterpartType", score, tier, reason, "captureStatus",
      "matchFitConfidence", contributions, "organizationId")
    SELECT 'b45e_match_' || s.id, s.id, 'contact', 'b45e_iso_0', 'opportunity', 66, 'WARM', 'Test reason', 'EXTERNAL_BOTH', 'MEDIUM', '{}', $2
    FROM unnest($1::text[]) AS s(id)`, [withMatch.map(s => s.id), DF_ORG])
  await df.query(`INSERT INTO "CallQueueEntry" (id, "organizationId", "contactId", rank, "priorityScore", reason, "primaryMatchId", "generationRunId")
    SELECT 'b45e_cqe_' || s.id, $2, s.id, n::int, 60, 'Test reason', 'b45e_match_' || s.id, 'b45e_run'
    FROM unnest($1::text[]) WITH ORDINALITY AS s(id, n)`, [withMatch.map(s => s.id), DF_ORG])

  // One new lead was copied on an earlier try: a value to keep, blanks to
  // fill, and a stale match (that buyer is gone) to delete.
  const pre = newLeads[0]
  if (pre) {
    await df.query(`INSERT INTO "MojoContact" (id, "mojoId", "fullName", status, metadata, tags, groups, "updatedAt", "organizationId")
      VALUES ('b45e_mc_pre', $1, 'Test Owner pre', 'Earlier status', $2, '{}', '{}', now(), $3)`,
    [pre.mojoId, JSON.stringify({ source: 'crm', crmLeadId: pre.id }), DF_ORG])
    await df.query(`INSERT INTO "Match" (id, "opportunityId", "opportunityType", "counterpartId", "counterpartType", score, tier, "organizationId")
      VALUES ('b45e_match_stale_pre', 'b45e_mc_pre', 'contact', 'b45e_iso_gone', 'opportunity', 61, 'POSSIBLE', $1)`, [DF_ORG])
  }

  return {
    token, existing, newLeads, noMojo, merged, preCopied: pre?.id ?? '',
    requestIds: [...newLeads, ...noMojo, ...merged].map(p => p.id),
  }
}
