import { Pool } from '@prisma/adapter-pg'
import pkg from 'pg'
const { Pool: PgPool } = pkg

const pool = new PgPool({ connectionString: 'postgresql://postgres:postgres@localhost:5433/dealflow_inbox' })

const r = await pool.query(`
  SELECT "extractedTitle", address, neighborhood, beds, price, category, "createdAt"
  FROM "ExtractedOpportunity"
  WHERE "isDuplicate" = false
  ORDER BY "createdAt" DESC
  LIMIT 30
`)
console.table(r.rows.map(r => ({
  title: r.extractedTitle?.slice(0,40),
  address: r.address?.slice(0,30),
  neighborhood: r.neighborhood,
  beds: r.beds,
  price: r.price,
  category: r.category,
})))

const r2 = await pool.query(`SELECT COUNT(*) FROM "ExtractedOpportunity" WHERE "isDuplicate" = false`)
console.log('Total non-duplicate opportunities:', r2.rows[0].count)

await pool.end()
