import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import OpenAI from 'openai'

export const dynamic = 'force-dynamic'

async function embedContact(c: {
  fullName: string; address?: string | null; city?: string | null;
  neighborhood?: string | null; notes?: string | null; tags?: string[]
}) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const text = [c.fullName, c.address, c.city, c.neighborhood, c.notes, ...(c.tags ?? [])]
    .filter(Boolean).join(' ')
  const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text })
  return res.data[0].embedding
}

export async function POST(req: NextRequest) {
  // Validate shared secret so only API Nation can call this
  const secret = req.headers.get('x-mojo-secret')
  if (process.env.MOJO_WEBHOOK_SECRET && secret !== process.env.MOJO_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // API Nation may send a single contact or an array
  const contacts = Array.isArray(body) ? body : [body]
  let upserted = 0

  for (const raw of contacts) {
    const c = raw as Record<string, unknown>
    const mojoId = String(c.id ?? c.mojoId ?? c.contact_id ?? '')
    if (!mojoId) continue

    const fullName = String(c.full_name ?? c.fullName ?? c.name ?? '')
    const address  = String(c.property_address ?? c.address ?? c.street_address ?? '')
    const city     = String(c.property_city ?? c.city ?? '')
    const state    = String(c.property_state ?? c.state ?? '')
    const zipCode  = String(c.property_zip_code ?? c.zip_code ?? c.zipCode ?? '')
    const phone    = String(c.phone ?? c.phone_number ?? '')
    const email    = String(c.email ?? c.email_address ?? '')
    const status   = String(c.status ?? c.lead_status ?? '')
    const notes    = String(c.notes ?? c.call_notes ?? '')
    const mojoList = String(c.list_name ?? c.group_name ?? c.mojoList ?? '')
    const tags: string[] = Array.isArray(c.tags) ? c.tags.map(String) : []

    // Derive neighborhood from city/address for NYC leads
    const neighborhood = deriveNeighborhood(city, address, zipCode)

    let embedding: number[] | null = null
    try { embedding = await embedContact({ fullName, address, city, neighborhood, notes, tags }) } catch { /* non-fatal */ }

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
    upserted++
  }

  return NextResponse.json({ ok: true, upserted })
}

// Simple neighborhood inference for NYC zip codes / city values
function deriveNeighborhood(city: string, address: string, zip: string): string | null {
  const combined = `${city} ${address} ${zip}`.toLowerCase()
  const NYC_ZIPS: Record<string, string> = {
    '10013': 'tribeca', '10007': 'tribeca', '10012': 'soho', '10014': 'west village',
    '10011': 'chelsea', '10001': 'chelsea', '10010': 'gramercy', '10003': 'east village',
    '10002': 'lower east side', '10004': 'financial district', '10006': 'financial district',
    '10005': 'financial district', '10280': 'battery park city', '10023': 'upper west side',
    '10024': 'upper west side', '10025': 'upper west side', '10021': 'upper east side',
    '10022': 'upper east side', '10065': 'upper east side', '10075': 'upper east side',
    '10128': 'upper east side', '10029': 'east harlem', '10035': 'east harlem',
    '11201': 'brooklyn heights', '11231': 'carroll gardens', '11217': 'park slope',
    '11215': 'park slope', '11238': 'prospect heights', '11216': 'crown heights',
    '11221': 'bushwick', '11206': 'williamsburg', '11211': 'williamsburg',
    '11222': 'greenpoint', '11205': 'fort greene', '11233': 'bed-stuy',
    '11213': 'crown heights', '11225': 'flatbush',
  }
  const matchedZip = Object.entries(NYC_ZIPS).find(([z]) => combined.includes(z))
  if (matchedZip) return matchedZip[1]
  // Fall back to using city as neighborhood for Brooklyn/Queens sub-areas
  if (combined.includes('brooklyn')) return 'brooklyn'
  if (combined.includes('queens')) return 'queens'
  if (combined.includes('bronx')) return 'bronx'
  return null
}
