import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isSuppressed } from '@/lib/suppression'
import OpenAI from 'openai'

export const dynamic = 'force-dynamic'

const INSTANTLY_API = 'https://api.instantly.ai/api/v1'

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

// Calls Instantly API to unsubscribe an email from a specific campaign.
// Fire-and-forget — webhook response never waits on this.
async function unsubscribeFromInstantly(email: string, campaignId: string) {
  const apiKey = process.env.INSTANTLY_API_KEY
  if (!apiKey) return
  try {
    await fetch(`${INSTANTLY_API}/lead/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, campaign_id: campaignId, delete_list: [email] }),
    })
  } catch (e) {
    console.error('[Mojo Webhook] Instantly unsubscribe failed:', (e as Error).message)
  }
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-mojo-secret')
  if (process.env.MOJO_WEBHOOK_SECRET && secret !== process.env.MOJO_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

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
    const status   = String(c.status ?? c.lead_status ?? c['Call Result'] ?? c.call_result ?? '')
    const notes    = String(c.notes ?? c.call_notes ?? '')
    const mojoList = String(c.list_name ?? c['List Name'] ?? c.group_name ?? c.mojoList ?? '')
    const tags: string[] = Array.isArray(c.tags) ? c.tags.map(String) : []

    const rawGroups = c.groups ?? c.Groups ?? c['Groups'] ?? null
    const groups: string[] = Array.isArray(rawGroups)
      ? rawGroups.map(String).filter(Boolean)
      : typeof rawGroups === 'string' && rawGroups.trim()
        ? rawGroups.split(',').map(s => s.trim()).filter(Boolean)
        : []

    const parseDate = (v: unknown): Date | null => {
      if (!v) return null
      const d = new Date(String(v))
      return isNaN(d.getTime()) ? null : d
    }
    const lastCalled   = parseDate(c['Last Contact Date'] ?? c.last_contact_date ?? c.lastCalled)
    const lastDialDate = parseDate(c['Last Dial Date'] ?? c.last_dial_date ?? c.lastDialDate)

    const toFloat = (v: unknown): number | null => {
      const n = parseFloat(String(v ?? ''))
      return isNaN(n) ? null : n
    }
    const estimatedValue   = toFloat(c['Estimated Value']        ?? c.estimated_value)
    const equityBalance    = toFloat(c['Equity Current Balance'] ?? c.equity_current_balance)
    const currentLTV       = toFloat(c['Current LTV']           ?? c.current_ltv)
    const totalLoanBalance = toFloat(c['Total Loan Balance']     ?? c.total_loan_balance)
    const loanInterestRate = toFloat(c['Loan Interest Rate']     ?? c.loan_interest_rate)

    const neighborhood = deriveNeighborhood(city, address, zipCode)

    // Read existing Instantly state before the upsert
    const existing = await prisma.mojoContact.findUnique({
      where: { mojoId },
      select: { instantlyStatus: true, instantlyCampaignId: true, email: true },
    })

    // Determine new Instantly status based on incoming groups
    const nowSuppressed = isSuppressed(groups, status)
    let newInstantlyStatus: string | null = existing?.instantlyStatus ?? null
    if (nowSuppressed && (newInstantlyStatus === null || newInstantlyStatus === 'enrolled')) {
      newInstantlyStatus = newInstantlyStatus === 'enrolled' ? 'unsubscribed' : 'suppressed'
    }

    let embedding: number[] | null = null
    try { embedding = await embedContact({ fullName, address, city, neighborhood, notes, tags }) } catch { /* non-fatal */ }

    await prisma.$executeRaw`
      INSERT INTO "MojoContact" (
        id, "mojoId", "fullName", phone, email, address, city, state, "zipCode",
        neighborhood, status, tags, notes, "mojoGroup", "mojoList", groups,
        "lastCalled", "lastDialDate",
        "estimatedValue", "equityBalance", "currentLTV", "totalLoanBalance", "loanInterestRate",
        "instantlyStatus",
        "syncedAt", "createdAt", "updatedAt", embedding
      ) VALUES (
        gen_random_uuid()::text, ${mojoId}, ${fullName}, ${phone || null}, ${email || null},
        ${address || null}, ${city || null}, ${state || null}, ${zipCode || null},
        ${neighborhood || null}, ${status || null}, ${tags}, ${notes || null},
        ${'NYC Leads'}, ${mojoList || null}, ${groups},
        ${lastCalled}, ${lastDialDate},
        ${estimatedValue}, ${equityBalance}, ${currentLTV}, ${totalLoanBalance}, ${loanInterestRate},
        ${newInstantlyStatus},
        NOW(), NOW(), NOW(),
        ${embedding ? `[${embedding.join(',')}]` : null}::vector
      )
      ON CONFLICT ("mojoId") DO UPDATE SET
        "fullName"         = EXCLUDED."fullName",
        phone              = EXCLUDED.phone,
        email              = EXCLUDED.email,
        address            = EXCLUDED.address,
        city               = EXCLUDED.city,
        state              = EXCLUDED.state,
        "zipCode"          = EXCLUDED."zipCode",
        neighborhood       = EXCLUDED.neighborhood,
        status             = COALESCE(EXCLUDED.status, "MojoContact".status),
        tags               = EXCLUDED.tags,
        notes              = COALESCE(EXCLUDED.notes, "MojoContact".notes),
        "mojoList"         = COALESCE(EXCLUDED."mojoList", "MojoContact"."mojoList"),
        groups             = CASE WHEN array_length(EXCLUDED.groups, 1) > 0 THEN EXCLUDED.groups ELSE "MojoContact".groups END,
        "lastCalled"       = COALESCE(EXCLUDED."lastCalled", "MojoContact"."lastCalled"),
        "lastDialDate"     = COALESCE(EXCLUDED."lastDialDate", "MojoContact"."lastDialDate"),
        "estimatedValue"   = COALESCE(EXCLUDED."estimatedValue", "MojoContact"."estimatedValue"),
        "equityBalance"    = COALESCE(EXCLUDED."equityBalance", "MojoContact"."equityBalance"),
        "currentLTV"       = COALESCE(EXCLUDED."currentLTV", "MojoContact"."currentLTV"),
        "totalLoanBalance" = COALESCE(EXCLUDED."totalLoanBalance", "MojoContact"."totalLoanBalance"),
        "loanInterestRate" = COALESCE(EXCLUDED."loanInterestRate", "MojoContact"."loanInterestRate"),
        "instantlyStatus"  = CASE
          WHEN EXCLUDED."instantlyStatus" = 'unsubscribed' OR EXCLUDED."instantlyStatus" = 'suppressed'
          THEN EXCLUDED."instantlyStatus"
          ELSE COALESCE("MojoContact"."instantlyStatus", EXCLUDED."instantlyStatus")
        END,
        "syncedAt"         = NOW(),
        "updatedAt"        = NOW(),
        embedding          = COALESCE(EXCLUDED.embedding, "MojoContact".embedding)
    `
    upserted++

    // If this contact just became suppressed and was previously enrolled, remove from Instantly
    const wasEnrolled = existing?.instantlyStatus === 'enrolled'
    const campaignId  = existing?.instantlyCampaignId
    const contactEmail = email || existing?.email
    if (wasEnrolled && nowSuppressed && campaignId && contactEmail) {
      unsubscribeFromInstantly(contactEmail, campaignId)
    }
  }

  return NextResponse.json({ ok: true, upserted })
}

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
  if (combined.includes('brooklyn')) return 'brooklyn'
  if (combined.includes('queens')) return 'queens'
  if (combined.includes('bronx')) return 'bronx'
  return null
}
