export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { formatPriceRange } from '@/lib/utils'
import { isMatchingTestModeOnly } from '@/lib/config/matchingTestMode'
import { resolveSupply } from '@/lib/matching/supplyResolver'
import { draftOutreachSystemPrompt } from '@/lib/matching/draftPrompt'
import { MIXED_TEST_PAIR, isMixedTestPair, matchSides } from '@/lib/matching/pairSafety'

// POST /api/matches/[id]/draft-outreach
// Body: { channel: 'email' | 'text' }
// Response: { subject?, body, to: { name, email, phone } }
// Drafts a short outreach message with Claude Sonnet 4.6 (product-surface call per
// CLAUDE.md — do NOT downgrade to a utility model). Nothing is ever sent: the
// client hands the draft off to the native Mail/Messages app. The `to` block lets
// the sheet build the mailto:/sms: link (and disable it when contact is missing).
//
// Cost caps (Sonnet 4.6 ~$3/1M in, $15/1M out): a bounded max_tokens keeps any
// single draft well under $0.02, and we refuse (429) once the org's OUTREACH_DRAFT
// spend for the current UTC day crosses $2. Per-user == per-org (singleton tenant).

const MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 400
const COST_PER_1M_INPUT = 3.0
const COST_PER_1M_OUTPUT = 15.0
const PER_DRAFT_CAP_USD = 0.02
const PER_DAY_CAP_USD = 2.0

let client: Anthropic | null = null
function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
    client = new Anthropic({ apiKey })
  }
  return client
}

interface Party {
  name: string
  role: string
  email: string | null
  phone: string | null
  budget: string | null
  beds: string | null
  neighborhood: string | null
}

function roleForCategory(category: string): string {
  switch (category) {
    case 'BUYER_ISO':       return 'buyer ISO'
    case 'RENTER_INQUIRY':  return 'renter inquiry'
    default:                return category.toLowerCase().replace(/_/g, ' ')
  }
}

async function resolveParty(counterpartType: string, counterpartId: string): Promise<Party | null> {
  if (counterpartType === 'mojo') {
    const c = await prisma.mojoContact.findUnique({
      where: { id: counterpartId },
      select: { fullName: true, email: true, phone: true, neighborhood: true, city: true },
    })
    if (!c) return null
    return {
      name: c.fullName,
      role: 'mojo lead',
      email: c.email,
      phone: c.phone,
      budget: null,
      beds: null,
      neighborhood: c.neighborhood ?? c.city ?? null,
    }
  }
  if (counterpartType === 'opportunity') {
    const c = await prisma.extractedOpportunity.findUnique({
      where: { id: counterpartId },
      select: {
        category: true, extractedTitle: true, sourceAgentName: true, sourceAgentEmail: true,
        price: true, minPrice: true, maxPrice: true, beds: true, neighborhood: true,
      },
    })
    if (!c) return null
    return {
      name: c.sourceAgentName ?? c.extractedTitle,
      role: roleForCategory(c.category),
      email: c.sourceAgentEmail,
      phone: null,
      budget: formatPriceRange(c.minPrice, c.maxPrice, c.price) || null,
      beds: c.beds ? `${c.beds}BR` : null,
      neighborhood: c.neighborhood,
    }
  }
  return null // showing_confirmation: no counterpart party to draft to
}

function startOfUtcDay(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

async function spentTodayUsd(organizationId: string): Promise<number> {
  const rows = await prisma.auditLog.findMany({
    where: { organizationId, action: 'OUTREACH_DRAFT', createdAt: { gte: startOfUtcDay() } },
    select: { detailsJson: true },
  })
  return rows.reduce((sum, r) => {
    const d = r.detailsJson as { costUsd?: number } | null
    return sum + (typeof d?.costUsd === 'number' ? d.costUsd : 0)
  }, 0)
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params

  let body: { channel?: string } = {}
  try { body = (await req.json()) as typeof body } catch { /* handled below */ }
  const channel = body.channel === 'text' ? 'text' : body.channel === 'email' ? 'email' : null
  if (!channel) return NextResponse.json({ error: "channel must be 'email' or 'text'" }, { status: 400 })

  const match = await prisma.match.findUnique({
    where: { id },
    select: {
      id: true, organizationId: true, counterpartType: true, counterpartId: true,
      reason: true, opportunityId: true, opportunityType: true,
    },
  })
  if (!match) return NextResponse.json({ error: 'match not found' }, { status: 404 })
  // Brief 35: never draft across test data and a real homeowner.
  if (isMixedTestPair(...await matchSides(prisma, match))) return NextResponse.json(MIXED_TEST_PAIR, { status: 409 })

  // Test-mode isolation: MojoContact has no isTestData column yet (Brief 7.2 will
  // add it), so every Mojo row is real production data. Block drafts against Mojo
  // counterparts while the matching engine is in test-mode. Opportunity counterparts
  // are already filtered to isTestData=true by the list view, so drafts against
  // them are safe here.
  if (isMatchingTestModeOnly() && match.counterpartType === 'mojo') {
    return NextResponse.json(
      { error: 'drafts against Mojo contacts are disabled in test mode' },
      { status: 409 },
    )
  }

  // Daily cost cap — refuse before spending anything more.
  const spent = await spentTodayUsd(match.organizationId)
  if (spent >= PER_DAY_CAP_USD) {
    return NextResponse.json(
      { error: `daily draft budget of $${PER_DAY_CAP_USD} reached`, spentUsd: Number(spent.toFixed(4)) },
      { status: 429 },
    )
  }

  const party = await resolveParty(match.counterpartType, match.counterpartId)
  if (!party) return NextResponse.json({ error: 'no counterpart party to draft to' }, { status: 400 })

  // Brief 32 — supply may be an ExtractedOpportunity or a MojoContact seller.
  const opp = await resolveSupply(prisma, match.opportunityId, match.opportunityType)
  if (!opp) return NextResponse.json({ error: 'listing side not found' }, { status: 404 })
  // Brief 41 (H7): never a homeowner's name, our estimate or a seller-circumstance reason.
  const listingAddress = opp.address ?? opp.extractedTitle
  const system = draftOutreachSystemPrompt({ channel, party, supply: opp, matchReason: match.reason, counterpartType: match.counterpartType })

  let resp: Anthropic.Messages.Message
  try {
    resp = await getClient().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: `Draft the ${channel}. Return only the JSON.` }],
    })
  } catch (e) {
    return NextResponse.json({ error: `draft generation failed: ${(e as Error).message}` }, { status: 502 })
  }

  const inputTokens = resp.usage.input_tokens
  const outputTokens = resp.usage.output_tokens
  const costUsd = (inputTokens / 1_000_000) * COST_PER_1M_INPUT
                + (outputTokens / 1_000_000) * COST_PER_1M_OUTPUT

  const block = resp.content[0]
  if (!block || block.type !== 'text') {
    return NextResponse.json({ error: 'model returned non-text response' }, { status: 502 })
  }
  const text = block.text.trim()
  const jsonStart = text.indexOf('{')
  const jsonEnd = text.lastIndexOf('}')
  let parsed: { subject?: string; body?: string } = {}
  try { parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) } catch { /* fall through */ }
  const draftBody = (parsed.body ?? '').trim()
  const draftSubject = channel === 'email' ? (parsed.subject ?? `${listingAddress} — worth a look?`).trim() : undefined
  if (!draftBody) return NextResponse.json({ error: 'model returned an empty draft' }, { status: 502 })

  // Log spend so the daily cap tracks. Per-draft cap is a safety ceiling: max_tokens
  // bounds cost far below it, but flag if the estimate ever exceeds it.
  await prisma.auditLog.create({
    data: {
      organizationId: match.organizationId,
      action: 'OUTREACH_DRAFT',
      detailsJson: {
        matchId: id,
        channel,
        inputTokens,
        outputTokens,
        costUsd: Number(costUsd.toFixed(6)),
        overPerDraftCap: costUsd > PER_DRAFT_CAP_USD,
        at: new Date().toISOString(),
      },
    },
  })

  return NextResponse.json({
    subject: draftSubject,
    body: draftBody,
    to: { name: party.name, email: party.email, phone: party.phone },
  })
}
