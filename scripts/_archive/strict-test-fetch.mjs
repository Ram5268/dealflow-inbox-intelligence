// Fetch 3 failing samples' full content for strict-schema test.
import 'dotenv/config'
import pg from 'pg'
const { Client } = pg
const c = new Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

const ids = [
  'cmpxb8l3r00aeh68oeylvie2n', // ACTIVE_SALE_LISTING
  'cmpxb8gzv00a9h68ob94kgp3r', // ACTIVE_SALE_LISTING
  'cmpxb9xgv00azh68oedpjtna3', // DEVELOPMENT_INVENTORY
]
const r = await c.query(`
SELECT eo.id, eo.category, eo."classificationReason",
       re.id AS raw_id, re.subject, re."senderName", re."senderEmail",
       re."bodyPreview", re."bodyContent", re."attachmentsText"
FROM "ExtractedOpportunity" eo
JOIN "RawEmail" re ON re.id = eo."rawEmailId"
WHERE eo.id = ANY($1::text[])
`, [ids])

const samples = r.rows.map(row => ({
  oppId: row.id,
  category: row.category,
  baselineReason: row.classificationReason,
  rawEmailId: row.raw_id,
  subject: row.subject,
  senderName: row.senderName,
  senderEmail: row.senderEmail,
  bodyPreview: row.bodyPreview,
  bodyContent: row.bodyContent,
  attachmentsText: row.attachmentsText,
  attachmentNames: [],
}))
console.log(JSON.stringify(samples, null, 2).slice(0, 200))
import { writeFileSync } from 'fs'
writeFileSync('/tmp/strict-samples.json', JSON.stringify(samples))
console.log('SAVED', samples.length, 'samples to /tmp/strict-samples.json')
for (const s of samples) {
  console.log({
    id: s.oppId, cat: s.category,
    subj: s.subject?.slice(0,80),
    bodyLen: s.bodyContent?.length ?? 0,
    previewLen: s.bodyPreview?.length ?? 0,
    attLen: s.attachmentsText?.length ?? 0,
    reason: s.baselineReason,
  })
}
await c.end()
