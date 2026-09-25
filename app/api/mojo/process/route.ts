import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import OpenAI from 'openai'
import { isTestModeOnly } from '@/lib/config/testMode'
import { NYC_ZIP_NEIGHBORHOODS } from '@/lib/geo/zipNeighborhood'

export const dynamic = 'force-dynamic'

function deriveNeighborhood(city: string, address: string, zip: string): string | null {
  const combined = `${city} ${address} ${zip}`.toLowerCase()
  const matchedZip = Object.entries(NYC_ZIP_NEIGHBORHOODS).find(([z]) => combined.includes(z))
  if (matchedZip) return matchedZip[1]
  if (combined.includes('brooklyn')) return 'brooklyn'
  if (combined.includes('queens')) return 'queens'
  if (combined.includes('bronx')) return 'bronx'
  return null
}

export async function POST() {
  if (isTestModeOnly()) return NextResponse.json({ ok: false, reason: 'TEST_MODE_ONLY is on' })
  // Only process rows API Nation has written that haven't been transformed yet
  const rows = await prisma.mojoRaw.findMany({ where: { processed: false }, take: 200 })
  if (rows.length === 0) return NextResponse.json({ ok: true, processed: 0 })

  let processed = 0

  for (const row of rows) {
    const fullName = [row.firstName, row.lastName].filter(Boolean).join(' ').trim()
    if (!fullName) {
      await prisma.mojoRaw.update({ where: { id: row.id }, data: { processed: true } })
      continue
    }

    // Stable mojoId: use the one API Nation provides, fall back to name+phone hash
    const mojoId = row.mojoId ?? `${fullName}-${row.phone ?? ''}`.replace(/\s+/g, '-').toLowerCase()

    const address  = row.address  ?? ''
    const city     = row.city     ?? ''
    const state    = row.state    ?? ''
    const zipCode  = row.zipCode  ?? ''
    const phone    = row.phone    ?? ''
    const email    = row.email    ?? ''
    const status   = row.status   ?? ''
    const notes    = row.notes    ?? ''
    const mojoList = row.mojoList ?? ''
    const tags     = row.tags ? row.tags.split(',').map(t => t.trim()).filter(Boolean) : []
    const neighborhood = deriveNeighborhood(city, address, zipCode)

    let embedding: number[] | null = null
    try {
      const text = [fullName, address, city, neighborhood, notes, ...tags].filter(Boolean).join(' ')
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
      const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text })
      embedding = res.data[0].embedding
    } catch { /* non-fatal — contact still saved without embedding */ }

    try {
      await prisma.$executeRaw`
        INSERT INTO "MojoContact" (
          id, "mojoId", "fullName", phone, email, address, city, state, "zipCode",
          neighborhood, status, tags, notes, "mojoGroup", "mojoList", "syncedAt", "createdAt", "updatedAt",
          embedding
        ) VALUES (
          gen_random_uuid()::text, ${mojoId}, ${fullName}, ${phone || null}, ${email || null},
          ${address || null}, ${city || null}, ${state || null}, ${zipCode || null},
          ${neighborhood || null}, ${status || null}, ${tags}, ${notes || null},
          ${'NYC Leads'}, ${mojoList || null}, NOW(), NOW(), NOW(),
          ${embedding ? `[${embedding.join(',')}]` : null}::vector
        )
        ON CONFLICT ("mojoId") DO UPDATE SET
          "fullName"     = EXCLUDED."fullName",
          phone          = EXCLUDED.phone,
          email          = EXCLUDED.email,
          address        = EXCLUDED.address,
          city           = EXCLUDED.city,
          state          = EXCLUDED.state,
          "zipCode"      = EXCLUDED."zipCode",
          neighborhood   = EXCLUDED.neighborhood,
          status         = EXCLUDED.status,
          tags           = EXCLUDED.tags,
          notes          = EXCLUDED.notes,
          "mojoList"     = EXCLUDED."mojoList",
          "syncedAt"     = NOW(),
          "updatedAt"    = NOW(),
          embedding      = COALESCE(EXCLUDED.embedding, "MojoContact".embedding)
      `
      processed++
    } catch { /* log and continue so one bad row doesn't block the rest */ }

    await prisma.mojoRaw.update({ where: { id: row.id }, data: { processed: true } })
  }

  return NextResponse.json({ ok: true, processed })
}
