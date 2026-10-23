// Brief 48 (PR 7): made-up data for the CRM lead copy's database tests
// (crmSyncGolden.integration.test.ts, crmWins.integration.test.ts), written
// straight into two *_test databases: DealFlow's (DATABASE_URL, with DealFlow's
// schema) and a CRM one (CRM_TEST_DATABASE_URL). Fictional people ("Pat
// Example"), streets ("12 Sample St"), 555-01xx phones and example.com addresses
// only. Each side gets its own organization (slug dealflow-ryan, ids b48a_…), so
// cleanup is one organization's rows. Not a *.test.ts file.
//
// The CRM database needs only the columns the copy reads; createCrmTables makes
// them on an empty *_test database (a database with the CRM's real schema
// already has them, and the inserts fill every column it requires), with the
// CRM's cascades (a lead's contacts and values, a contact's phones and emails),
// so Brief 45's scoreImport.integration.test.ts runs on them too (with an
// ImportBatch table).
import type { Client } from 'pg'
import { isTestDatabase } from '../../dbGuard'

export const P = 'b48a_'
export const DF_ORG = `${P}org`
export const CRM_ORG = `${P}crmorg`

export function requireTestUrls(): { crmUrl: string | undefined } {
  const crmUrl = process.env.CRM_TEST_DATABASE_URL
  if (crmUrl && !isTestDatabase(crmUrl)) throw new Error('REFUSING: CRM_TEST_DATABASE_URL must name a *_test or *_perf database')
  return { crmUrl }
}

export async function createCrmTables(crm: Client) {
  const [{ d }] = (await crm.query('SELECT current_database() AS d')).rows
  if (!/(_test|_perf)$/.test(d)) throw new Error('REFUSING: not a test database')
  await crm.query(`
    CREATE TABLE IF NOT EXISTS "Organization" (id text PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL, "createdAt" timestamp(3) NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS "Lead" (id text PRIMARY KEY, "organizationId" text NOT NULL, "displayName" text NOT NULL, name text, source text,
      "primaryAddressFull" text, "mojoId" text UNIQUE, "createdAt" timestamp(3) NOT NULL DEFAULT now(), "updatedAt" timestamp(3) NOT NULL);
    CREATE TABLE IF NOT EXISTS "Contact" (id text PRIMARY KEY, "organizationId" text NOT NULL, "leadId" text NOT NULL REFERENCES "Lead"(id) ON DELETE CASCADE, "displayName" text NOT NULL,
      name text, "createdAt" timestamp(3) NOT NULL DEFAULT now(), "updatedAt" timestamp(3) NOT NULL);
    CREATE TABLE IF NOT EXISTS "ContactPhone" (id text PRIMARY KEY, "contactId" text NOT NULL REFERENCES "Contact"(id) ON DELETE CASCADE, phone text NOT NULL, type text NOT NULL,
      "isPrimary" boolean NOT NULL DEFAULT false, "lineType" text, "createdAt" timestamp(3) NOT NULL DEFAULT now(), "updatedAt" timestamp(3) NOT NULL);
    CREATE TABLE IF NOT EXISTS "ContactEmail" (id text PRIMARY KEY, "contactId" text NOT NULL REFERENCES "Contact"(id) ON DELETE CASCADE, email text NOT NULL, type text NOT NULL,
      "isUnsubscribed" boolean NOT NULL DEFAULT false, "isPrimary" boolean NOT NULL DEFAULT false);
    CREATE TABLE IF NOT EXISTS "CustomFieldDefinition" (id text PRIMARY KEY, "organizationId" text NOT NULL, "objectType" text NOT NULL, name text NOT NULL,
      type text NOT NULL, "displayOrder" int NOT NULL, "updatedAt" timestamp(3) NOT NULL);
    CREATE TABLE IF NOT EXISTS "CustomFieldValue" (id text PRIMARY KEY, "organizationId" text NOT NULL, "definitionId" text NOT NULL, "objectType" text NOT NULL,
      "objectId" text NOT NULL REFERENCES "Lead"(id) ON DELETE CASCADE, "valueText" text, "valueNumber" float8, "valueDate" timestamp(3), "valueJson" jsonb);
    CREATE TABLE IF NOT EXISTS "DncSuppression" (id text PRIMARY KEY, "organizationId" text NOT NULL, phone text NOT NULL, source text NOT NULL,
      "addedAt" timestamp(3) NOT NULL DEFAULT now());`)
}

export async function cleanup(df: Client, crm: Client) {
  for (const t of ['AuditLog', 'MojoContact']) await df.query(`DELETE FROM "${t}" WHERE "organizationId" = $1`, [DF_ORG])
  await df.query(`DELETE FROM "FeatureFlag" WHERE id = 'CRM_WINS'`)
  await df.query(`DELETE FROM "Organization" WHERE id = $1`, [DF_ORG])
  await crm.query(`DELETE FROM "ContactPhone" WHERE starts_with(id, $1)`, [P])
  await crm.query(`DELETE FROM "ContactEmail" WHERE starts_with(id, $1)`, [P])
  for (const t of ['CustomFieldValue', 'Contact', 'Lead', 'CustomFieldDefinition', 'DncSuppression']) {
    await crm.query(`DELETE FROM "${t}" WHERE "organizationId" = $1`, [CRM_ORG])
  }
  await crm.query(`DELETE FROM "Organization" WHERE id = $1`, [CRM_ORG])
}

type F = { t?: string; n?: number; d?: string }
export interface SeedLead {
  key: string
  mojoId: string | null
  name: string | null
  displayName: string
  street: string
  phones: string[]
  emails: string[]
  fields: Record<string, F>
}

const base = (street: string, more: Record<string, F> = {}): Record<string, F> => ({
  'Property City': { t: 'Brooklyn' }, 'Property State': { t: 'NY' }, 'Property Zip Code': { t: '11221' }, ...more,
})

// The CRM's leads. Each `key` names the case it covers.
export const CRM_LEADS: SeedLead[] = [
  { key: 'edited', mojoId: `${P}m_edited`, name: 'Pat Example', displayName: 'Pat Example', street: '12 Sample St',
    phones: ['+17185550102', '+17185550101'], emails: ['pat@example.com'],
    fields: base('12 Sample St', {
      'Property Type': { t: 'Duplex' }, Bedrooms: { n: 6 }, 'Last Call Result': { t: 'Contact' },
      'Last Contacted Date': { d: '2026-10-15 10:30:00' }, 'Last Dial Date': { d: '2026-10-15 00:00:00' },
      Notes: { t: 'Left a voicemail. Spoke on 10/15, call back in spring.' }, 'Dialer List': { t: 'Brooklyn Duplexes' }, 'Call Attempts': { n: 3 },
    }) },
  { key: 'blanks', mojoId: `${P}m_blanks`, name: 'Robin Sample', displayName: 'Robin Sample', street: '40 Sample Ave',
    phones: ['+17185550103'], emails: [], fields: base('40 Sample Ave', { 'Last Call Result': { t: 'No Answer' } }) },
  { key: 'new', mojoId: `${P}m_new`, name: 'Morgan Example', displayName: 'Morgan Example', street: '60 Example Ave',
    phones: ['+17185550104'], emails: ['morgan@example.com'],
    fields: base('60 Example Ave', { 'Property Type': { t: 'Triplex' }, Bedrooms: { n: 9 }, 'Year Built': { n: 1905 }, 'Home Close Date': { d: '2001-03-02 00:00:00' } }) },
  { key: 'csv', mojoId: `${P}m_csv`, name: 'Jordan Sample', displayName: 'Jordan Sample', street: '14 Sample St',
    phones: ['+17185550105'], emails: [], fields: base('14 Sample St', { 'Last Call Result': { t: 'No Answer' } }) },
  { key: 'ownNotes', mojoId: `${P}m_notes`, name: 'Alex Sample', displayName: 'Alex Sample', street: '20 Example Ave',
    phones: ['+17185550106'], emails: [], fields: base('20 Example Ave', { Notes: { t: 'Asked for a valuation.' } }) },
  { key: 'dnc', mojoId: `${P}m_dnc`, name: 'Drew Placeholder', displayName: 'Drew Placeholder', street: '30 Example Ave',
    phones: ['+17185550109'], emails: [], fields: base('30 Example Ave', { 'Last Call Result': { t: 'No Answer' } }) },
  { key: 'flags', mojoId: `${P}m_flags`, name: 'Sam Example', displayName: 'Sam Example', street: '50 Example Ave',
    phones: ['+17185550117'], emails: [], fields: base('50 Example Ave') },
  { key: 'optOut', mojoId: `${P}m_optout`, name: 'Taylor Example', displayName: 'Taylor Example', street: '70 Example Ave',
    phones: ['+17185550108'], emails: [], fields: base('70 Example Ave', { 'Last Call Result': { t: 'Contact' } }) },
  { key: 'noName', mojoId: `${P}m_noname`, name: null, displayName: '9 Example Ave', street: '9 Example Ave',
    phones: ['+17185550110'], emails: [], fields: base('9 Example Ave', { 'Last Call Result': { t: 'Contact' } }) },
  { key: 'testRow', mojoId: `${P}m_testrow`, name: 'Quinn Example', displayName: 'Quinn Example', street: '80 Example Ave',
    phones: ['+17185550111'], emails: [], fields: base('80 Example Ave', { 'Last Call Result': { t: 'Contact' } }) },
]

const crmMeta = (key: string) => ({ source: 'crm', crmLeadId: `${P}lead_${key}`, crmUpdatedAt: '2026-10-01 12:00:00', callAttempts: null, lastCallResult: null, syncVersion: 1 })

// DealFlow's rows before the copy: as earlier copies (and, for the csv rows,
// DealFlow's old spreadsheet upload) left them.
export const DF_ROWS: Array<Record<string, unknown>> = [
  { id: `${P}mc_edited`, mojoId: `${P}m_edited`, fullName: 'Pat Exampel', phone: '7185550101', email: 'old@example.com', address: '12 Sample St',
    city: 'Brooklyn', state: 'NY', zipCode: '11221', neighborhood: 'Bedford-Stuyvesant', propertyTypeDetail: 'Duplex', unitCount: 2, propertyBeds: 6,
    lastCalled: '2026-08-01 09:00:00', lastDialDate: '2026-08-01 00:00:00', status: 'No Answer', notes: 'Left a voicemail.', mojoList: 'Brooklyn Duplexes',
    metadata: crmMeta('edited') },
  { id: `${P}mc_blanks`, mojoId: `${P}m_blanks`, fullName: 'Robin Sample', phone: '7185550103', address: '40 Sample Ave', city: 'Brooklyn', state: 'NY',
    zipCode: '11221', propertyTypeDetail: 'Triplex', unitCount: 3, propertyBeds: 4, yearBuilt: 1920, lastCalled: '2026-09-01 15:00:00',
    status: 'No Answer', notes: 'Owner prefers texts.', metadata: crmMeta('blanks') },
  { id: `${P}mc_csv1`, mojoId: `csv_${P}jordan_1`, fullName: 'Jordan Sample', phone: '7185550105', address: '14 Sample St', city: 'Brooklyn',
    state: 'NY', zipCode: '11221', notes: 'Beds: 4 | Baths: 2', metadata: null },
  { id: `${P}mc_csv2`, mojoId: `csv_${P}jordan_2`, fullName: 'JORDAN SAMPLE', address: '14 Sample Street', state: '14 Sample Street', zipCode: 'Brooklyn', metadata: null },
  { id: `${P}mc_notes`, mojoId: `${P}m_notes`, fullName: 'Alex Sample', phone: '7185550106', address: '20 Example Ave', city: 'Brooklyn', state: 'NY',
    zipCode: '11221', notes: 'Beds: 3 | Baths: 2 (old upload)', metadata: crmMeta('ownNotes') },
  { id: `${P}mc_dnc`, mojoId: `${P}m_dnc`, fullName: 'Drew Placeholder', phone: '7185550109', address: '30 Example Ave', city: 'Brooklyn', state: 'NY',
    zipCode: '11221', status: 'Do Not Call', metadata: crmMeta('dnc') },
  { id: `${P}mc_flags`, mojoId: `${P}m_flags`, fullName: 'Sam Example', phone: '7185550107', phoneDncFlags: [true], address: '50 Example Ave',
    city: 'Brooklyn', state: 'NY', zipCode: '11221', metadata: crmMeta('flags') },
  { id: `${P}mc_optout`, mojoId: `${P}m_optout`, fullName: 'Taylor Example', phone: '7185550108', address: '70 Example Ave', city: 'Brooklyn',
    state: 'NY', zipCode: '11221', status: 'Contact', metadata: crmMeta('optOut') },
  { id: `${P}mc_noname`, mojoId: `${P}m_noname`, fullName: 'Casey Example', phone: '7185550110', address: '9 Example Ave', city: 'Brooklyn',
    state: 'NY', zipCode: '11221', metadata: crmMeta('noName') },
  { id: `${P}mc_testrow`, mojoId: `${P}m_testrow`, fullName: 'Quinn Example', isTestData: true, metadata: null },
  { id: `${P}mc_removed`, mojoId: `${P}m_removed`, fullName: 'Jamie Sample', phone: '7185550112', address: '90 Example Ave', metadata: crmMeta('removed') },
  { id: `${P}mc_legacy`, mojoId: `${P}legacy`, fullName: 'Riley Sample', phone: '7185550113', metadata: null },
]

const FIELD_NAMES = [...new Set(CRM_LEADS.flatMap(l => Object.keys(l.fields)))].sort()
const CRM_UPDATED_AT = '2026-10-01 12:00:00'

export async function seed(df: Client, crm: Client, leads: SeedLead[] = CRM_LEADS, rows: Array<Record<string, unknown>> = DF_ROWS) {
  // ── CRM ──
  await crm.query(`INSERT INTO "Organization" (id, slug, name) VALUES ($1, 'dealflow-ryan', 'Test organization')`, [CRM_ORG])
  const names = [...new Set([...FIELD_NAMES, ...leads.flatMap(l => Object.keys(l.fields))])].sort()
  await crm.query(`INSERT INTO "CustomFieldDefinition" (id, "organizationId", "objectType", name, type, "displayOrder", "updatedAt")
    SELECT $1 || i, $2, 'lead', name, 'text', i, now() FROM unnest($3::text[]) WITH ORDINALITY AS d(name, i)`, [`${P}cfd_`, CRM_ORG, names])
  await crm.query(`INSERT INTO "Lead" (id, "organizationId", "displayName", name, "primaryAddressFull", "mojoId", "createdAt", "updatedAt")
    SELECT l.id, $2, l."displayName", l.name, l.address, l."mojoId", $3::timestamp, $3::timestamp
    FROM jsonb_to_recordset($1::jsonb) AS l(id text, "displayName" text, name text, address text, "mojoId" text)`,
  [JSON.stringify(leads.map(l => ({ id: `${P}lead_${l.key}`, displayName: l.displayName, name: l.name, address: `${l.street}, Brooklyn, NY 11221`, mojoId: l.mojoId }))), CRM_ORG, CRM_UPDATED_AT])
  await crm.query(`INSERT INTO "Contact" (id, "organizationId", "leadId", "displayName", "createdAt", "updatedAt")
    SELECT $3 || l.id, $2, l.id, 'Test contact', $4::timestamp, now() FROM unnest($1::text[]) AS l(id)`,
  [leads.map(l => `${P}lead_${l.key}`), CRM_ORG, `${P}con_`, CRM_UPDATED_AT])
  const phones = leads.flatMap(l => l.phones.map((phone, i) => ({ id: `${P}ph_${l.key}_${i}`, contact: `${P}con_${P}lead_${l.key}`, phone, primary: i === 0, at: `2026-01-01 00:00:0${i}` })))
  await crm.query(`INSERT INTO "ContactPhone" (id, "contactId", phone, type, "isPrimary", "createdAt", "updatedAt")
    SELECT p.id, p.contact, p.phone, 'mobile', p.primary, p.at::timestamp, now() FROM jsonb_to_recordset($1::jsonb) AS p(id text, contact text, phone text, "primary" boolean, at text)`,
  [JSON.stringify(phones)])
  const emails = leads.flatMap(l => l.emails.map((email, i) => ({ id: `${P}em_${l.key}_${i}`, contact: `${P}con_${P}lead_${l.key}`, email, primary: i === 0 })))
  await crm.query(`INSERT INTO "ContactEmail" (id, "contactId", email, type, "isPrimary")
    SELECT e.id, e.contact, e.email, 'work', e.primary FROM jsonb_to_recordset($1::jsonb) AS e(id text, contact text, email text, "primary" boolean)`,
  [JSON.stringify(emails)])
  const values = leads.flatMap(l => Object.entries(l.fields).map(([name, v]) => ({
    id: `${P}cfv_${l.key}_${names.indexOf(name) + 1}`, def: `${P}cfd_${names.indexOf(name) + 1}`, lead: `${P}lead_${l.key}`, t: v.t ?? null, n: v.n ?? null, d: v.d ?? null,
  })))
  await crm.query(`INSERT INTO "CustomFieldValue" (id, "organizationId", "definitionId", "objectType", "objectId", "valueText", "valueNumber", "valueDate")
    SELECT v.id, $2, v.def, 'lead', v.lead, v.t, v.n, v.d::timestamp FROM jsonb_to_recordset($1::jsonb) AS v(id text, def text, lead text, t text, n float8, d text)`,
  [JSON.stringify(values), CRM_ORG])
  // The opt-out case: a STOP reply recorded in the CRM (Brief 43 PR 5).
  await crm.query(`INSERT INTO "DncSuppression" (id, "organizationId", phone, source) VALUES ($1, $2, '+17185550108', 'internal')`, [`${P}dnc_1`, CRM_ORG])

  // ── DealFlow ──
  await df.query(`INSERT INTO "Organization" (id, name, slug, "updatedAt") VALUES ($1, 'Test organization', 'dealflow-ryan', now())`, [DF_ORG])
  await df.query(`INSERT INTO "MojoContact" (id, "mojoId", "fullName", phone, email, address, city, state, "zipCode", neighborhood, "propertyTypeDetail",
      "unitCount", "propertyBeds", "yearBuilt", "lastCalled", "lastDialDate", status, notes, "mojoList", "phoneDncFlags", metadata, "isTestData",
      tags, groups, "createdAt", "updatedAt", "organizationId")
    SELECT c.id, c."mojoId", c."fullName", c.phone, c.email, c.address, c.city, c.state, c."zipCode", c.neighborhood, c."propertyTypeDetail",
      c."unitCount", c."propertyBeds", c."yearBuilt", c."lastCalled", c."lastDialDate", c.status, c.notes, c."mojoList", COALESCE(c."phoneDncFlags", '{}'),
      c.metadata, COALESCE(c."isTestData", false), '{}', '{}', '2026-09-25 12:00:00', now(), $2
    FROM jsonb_to_recordset($1::jsonb) AS c(id text, "mojoId" text, "fullName" text, phone text, email text, address text, city text, state text,
      "zipCode" text, neighborhood text, "propertyTypeDetail" text, "unitCount" int, "propertyBeds" float8, "yearBuilt" int, "lastCalled" timestamp,
      "lastDialDate" timestamp, status text, notes text, "mojoList" text, "phoneDncFlags" boolean[], metadata jsonb, "isTestData" boolean)`,
  [JSON.stringify(rows), DF_ORG])
}

// Everything the copy can change in DealFlow for the test organization, in a
// stable form: rows by Mojo ID without their clock columns (a new row's random
// id becomes "<new>"), and the audit rows without their run time.
export async function dump(df: Client) {
  const contacts = (await df.query(`
    SELECT to_jsonb(m) - 'createdAt' - 'updatedAt' - 'syncedAt' - 'embedding' AS r FROM "MojoContact" m
    WHERE "organizationId" = $1 ORDER BY "mojoId"`, [DF_ORG])).rows.map(({ r }) => ({ ...r, id: String(r.id).startsWith(P) ? r.id : '<new>' }))
  const audit = (await df.query(`SELECT action, "detailsJson" - 'ms' AS details FROM "AuditLog" WHERE "organizationId" = $1 ORDER BY "createdAt", id`, [DF_ORG])).rows
  return { contacts, audit }
}

export const withoutMs = (r: object) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'ms'))
