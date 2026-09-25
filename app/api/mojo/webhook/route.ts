import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isSuppressed } from '@/lib/suppression'
import OpenAI from 'openai'
import { isTestModeOnly } from '@/lib/config/testMode'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { validateMojoContact } from '@/lib/mojo/validate'
import { geocodeAddress } from '@/lib/mojo/geocode'
import { parseNotes } from '@/lib/mojo/parseNotes'
import { NYC_ZIP_NEIGHBORHOODS } from '@/lib/geo/zipNeighborhood'

export const dynamic = 'force-dynamic'

const INSTANTLY_API = 'https://api.instantly.ai/api/v2'

// Brief 7.2 (Fix #3) — every top-level payload key the resolver below consumes,
// lowercased. Anything NOT in here is stashed in metadata.unmapped so new Mojo
// custom fields are preserved until we promote them to typed columns.
const KNOWN_KEYS = new Set(
  [
    'id', 'mojoId', 'contact_id',
    'full_name', 'fullName', 'name',
    'property_address', 'address', 'street_address',
    'property_city', 'city',
    'property_state', 'state',
    'property_zip_code', 'zip_code', 'zipCode',
    'phone', 'phone_number',
    'email', 'email_address',
    'status', 'lead_status', 'Call Result', 'call_result',
    'notes', 'call_notes',
    'list_name', 'List Name', 'group_name', 'mojoList',
    'tags',
    'groups', 'Groups',
    'Last Contact Date', 'last_contact_date', 'lastCalled',
    'Last Dial Date', 'last_dial_date', 'lastDialDate',
    'Estimated Value', 'estimated_value',
    'Equity Current Balance', 'equity_current_balance',
    'Current LTV', 'current_ltv',
    'Total Loan Balance', 'total_loan_balance',
    'Loan Interest Rate', 'loan_interest_rate',
    // Brief 7.2 (Fix #5) intent aliases
    'intent', 'interest', 'party_type', 'list_type',
  ].map(k => k.toLowerCase()),
)

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
  if (!process.env.INSTANTLY_API_KEY) return
  try {
    await fetch(`${INSTANTLY_API}/leads/delete`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.INSTANTLY_API_KEY}`,
      },
      body: JSON.stringify({ campaign_id: campaignId, emails: [email] }),
    })
  } catch (e) {
    console.error('[Mojo Webhook] Instantly unsubscribe failed:', (e as Error).message)
  }
}

// Brief 7.2 (Fix #5) — explicit intent wins; otherwise infer from the list name.
function resolveIntent(explicit: string, mojoList: string): 'SELLER' | 'BUYER' | 'RENTER' {
  const e = explicit.trim().toUpperCase()
  if (e === 'BUYER' || e === 'RENTER' || e === 'SELLER') return e
  const list = mojoList.toLowerCase()
  if (list.includes('buyer')) return 'BUYER'
  if (list.includes('renter')) return 'RENTER'
  return 'SELLER'
}

// Best-effort update of the ingest log; never let a log failure fail the webhook.
async function finishLog(
  id: string,
  data: { resultStatus: string; resultReason?: string | null; resultContactId?: string | null },
) {
  try {
    await prisma.zapierIngestLog.update({
      where: { id },
      data: { ...data, processedAt: new Date() },
    })
  } catch (e) {
    console.error('[Mojo Webhook] ingest-log update failed:', (e as Error).message)
  }
}

export async function POST(req: NextRequest) {
  if (isTestModeOnly()) return NextResponse.json({ ok: false, reason: 'TEST_MODE_ONLY is on' })
  const secret = req.headers.get('x-mojo-secret')
  if (process.env.MOJO_WEBHOOK_SECRET && secret !== process.env.MOJO_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const organizationId = await getCurrentOrgId()

  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Brief 7.2 (Fix #2) — persist the raw delivery FIRST, before any interpretation.
  // Insurance: if corruption appears or Zapier reformats upstream, we can replay.
  const logEntry = await prisma.zapierIngestLog.create({
    data: {
      organizationId,
      headers: Object.fromEntries(req.headers.entries()),
      body: body as object,
      resultStatus: 'pending',
    },
  })

  const contacts = Array.isArray(body) ? body : [body]
  let upserted = 0
  let firstContactId: string | null = null
  let firstRejectReason: string | null = null

  try {
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
      const intentRaw = String(c.intent ?? c.interest ?? c.party_type ?? c.list_type ?? '')

      // ── Fix #4: validate — one hard reject, everything else a log-only warning ──
      const validation = validateMojoContact({ fullName, email, address, city })
      if (!validation.ok) {
        firstRejectReason ??= validation.reason
        continue // do not upsert header rows
      }

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

      // ── Fix #5: intent (explicit alias wins; else infer from list name) ──────
      const intent = resolveIntent(intentRaw, mojoList)

      // ── Fix #6: neighborhood — zip fast-path, then Nominatim + Sonnet fallback ──
      let neighborhood = deriveNeighborhood(city, address, zipCode)
      if (!neighborhood && address) {
        try {
          neighborhood = (await geocodeAddress(`${address}, New York, NY`)).neighborhood
        } catch { /* non-fatal — leave null, never hallucinate */ }
      }

      // ── Fix #7: notes parser (Sonnet 4.6, hallucination-safe). Structured Mojo
      // custom fields would win here; today there are none, so the LLM fills all. ──
      let parsed
      try { parsed = await parseNotes(notes) } catch { parsed = null }
      const bedsMin             = parsed?.bedsMin ?? null
      const bedsMax             = parsed?.bedsMax ?? null
      const budgetMin           = parsed?.budgetMin ?? null
      const budgetMax           = parsed?.budgetMax ?? null
      const cashOnly            = parsed?.cashOnly ?? null
      const timing              = parsed?.timing ?? null
      const initialNeighborhood = parsed?.initialNeighborhood ?? null

      // ── Fix #3 + #4: metadata catch-all (unmapped keys + validation warnings) ──
      const unmapped: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(c)) {
        if (!KNOWN_KEYS.has(k.toLowerCase())) unmapped[k] = v
      }
      const metadata: Record<string, unknown> = {}
      if (Object.keys(unmapped).length > 0) metadata.unmapped = unmapped
      if (validation.warnings.length > 0) metadata.validationWarnings = validation.warnings
      const metadataJson = Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null

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
          id, "mojoId", "organizationId", "fullName", phone, email, address, city, state, "zipCode",
          neighborhood, status, tags, notes, "mojoGroup", "mojoList", groups,
          "lastCalled", "lastDialDate",
          "estimatedValue", "equityBalance", "currentLTV", "totalLoanBalance", "loanInterestRate",
          "instantlyStatus",
          "isTestData", intent,
          "bedsMin", "bedsMax", "budgetMin", "budgetMax", "cashOnly", timing, "initialNeighborhood",
          metadata,
          "syncedAt", "createdAt", "updatedAt", embedding
        ) VALUES (
          gen_random_uuid()::text, ${mojoId}, ${organizationId}, ${fullName}, ${phone || null}, ${email || null},
          ${address || null}, ${city || null}, ${state || null}, ${zipCode || null},
          ${neighborhood || null}, ${status || null}, ${tags}, ${notes || null},
          ${'NYC Leads'}, ${mojoList || null}, ${groups},
          ${lastCalled}, ${lastDialDate},
          ${estimatedValue}, ${equityBalance}, ${currentLTV}, ${totalLoanBalance}, ${loanInterestRate},
          ${newInstantlyStatus},
          ${false}, ${intent},
          ${bedsMin}, ${bedsMax}, ${budgetMin}, ${budgetMax}, ${cashOnly}, ${timing || null}, ${initialNeighborhood || null},
          ${metadataJson}::jsonb,
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
          neighborhood       = COALESCE(EXCLUDED.neighborhood, "MojoContact".neighborhood),
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
          intent             = COALESCE(EXCLUDED.intent, "MojoContact".intent),
          "bedsMin"          = COALESCE(EXCLUDED."bedsMin", "MojoContact"."bedsMin"),
          "bedsMax"          = COALESCE(EXCLUDED."bedsMax", "MojoContact"."bedsMax"),
          "budgetMin"        = COALESCE(EXCLUDED."budgetMin", "MojoContact"."budgetMin"),
          "budgetMax"        = COALESCE(EXCLUDED."budgetMax", "MojoContact"."budgetMax"),
          "cashOnly"         = COALESCE(EXCLUDED."cashOnly", "MojoContact"."cashOnly"),
          timing             = COALESCE(EXCLUDED.timing, "MojoContact".timing),
          "initialNeighborhood" = COALESCE(EXCLUDED."initialNeighborhood", "MojoContact"."initialNeighborhood"),
          metadata           = COALESCE("MojoContact".metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
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

      if (!firstContactId) {
        const row = await prisma.mojoContact.findUnique({ where: { mojoId }, select: { id: true } })
        firstContactId = row?.id ?? null
      }

      // If this contact just became suppressed and was previously enrolled, remove from Instantly
      const wasEnrolled = existing?.instantlyStatus === 'enrolled'
      const campaignId  = existing?.instantlyCampaignId
      const contactEmail = email || existing?.email
      if (wasEnrolled && nowSuppressed && campaignId && contactEmail) {
        unsubscribeFromInstantly(contactEmail, campaignId)
      }
    }
  } catch (e) {
    await finishLog(logEntry.id, { resultStatus: 'errored', resultReason: (e as Error).message })
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
  }

  // ── Resolve the delivery outcome for the ingest log + HTTP response ──────────
  if (upserted > 0) {
    await finishLog(logEntry.id, { resultStatus: 'upserted', resultContactId: firstContactId })
    return NextResponse.json({ ok: true, upserted })
  }
  if (firstRejectReason) {
    await finishLog(logEntry.id, { resultStatus: 'rejected', resultReason: firstRejectReason })
    return NextResponse.json({ ok: false, reason: firstRejectReason }, { status: 400 })
  }
  await finishLog(logEntry.id, { resultStatus: 'errored', resultReason: 'no_valid_contacts' })
  return NextResponse.json({ ok: true, upserted: 0 })
}

function deriveNeighborhood(city: string, address: string, zip: string): string | null {
  const combined = `${city} ${address} ${zip}`.toLowerCase()
  const matchedZip = Object.entries(NYC_ZIP_NEIGHBORHOODS).find(([z]) => combined.includes(z))
  if (matchedZip) return matchedZip[1]
  if (combined.includes('brooklyn')) return 'brooklyn'
  if (combined.includes('queens')) return 'queens'
  if (combined.includes('bronx')) return 'bronx'
  return null
}
