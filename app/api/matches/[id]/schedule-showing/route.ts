export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isMatchingTestModeOnly } from '@/lib/config/matchingTestMode'
import { createCalendarEvent } from '@/lib/microsoftCalendar'
import { resolveSupply } from '@/lib/matching/supplyResolver'
import { MIXED_TEST_PAIR, isMixedTestPair, matchSides } from '@/lib/matching/pairSafety'
import { crmLeadUrl } from '@/lib/crmLink'

// POST /api/matches/[id]/schedule-showing
// Body: { start: string (naive local "YYYY-MM-DDTHH:mm[:ss]"), durationMinutes: number }
// Creates a real Microsoft 365 calendar event via Graph POST /me/events. This is
// the ONLY write path to M365 in the whole app — email stays strictly read-only
// per CLAUDE.md. Every write is logged to AuditLog (action: CALENDAR_WRITE) and
// blocked with 409 while MATCHING_TEST_MODE_ONLY is on (no real writes in test).
//
// `start` is a naive local datetime (no timezone) so it maps 1:1 onto Graph's
// { dateTime, timeZone: America/New_York } shape (see lib/microsoftCalendar.ts).
// We add durationMinutes with timezone-agnostic arithmetic to avoid the server's
// local tz leaking into the computed end.

// Add minutes to a naive "YYYY-MM-DDTHH:mm[:ss]" string without interpreting it
// in the server's local timezone. Returns the same naive shape with seconds.
function addMinutesToLocal(local: string, minutes: number): string {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!m) throw new Error(`bad start datetime '${local}'`)
  const [, y, mo, d, h, mi, s] = m
  const base = Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0)
  const dt = new Date(base + minutes * 60_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}T${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}`
}

interface OppCounterpart { extractedTitle: string; sourceAgentName: string | null }
interface MojoCounterpart { fullName: string }

async function counterpartName(counterpartType: string, counterpartId: string): Promise<string | null> {
  if (counterpartType === 'mojo') {
    const c = await prisma.mojoContact.findUnique({ where: { id: counterpartId }, select: { fullName: true } })
    return (c as MojoCounterpart | null)?.fullName ?? null
  }
  if (counterpartType === 'opportunity') {
    const c = await prisma.extractedOpportunity.findUnique({
      where: { id: counterpartId },
      select: { sourceAgentName: true, extractedTitle: true },
    })
    const o = c as OppCounterpart | null
    return o ? (o.sourceAgentName ?? o.extractedTitle) : null
  }
  return null // showing_confirmation has no counterpart
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params

  // Block real M365 writes while the matching engine is in test-mode isolation.
  if (isMatchingTestModeOnly()) {
    return NextResponse.json({ error: 'calendar writes are disabled in test mode' }, { status: 409 })
  }

  let body: { start?: string; durationMinutes?: number } = {}
  try { body = (await req.json()) as typeof body } catch { /* handled below */ }
  const start = body.start
  const durationMinutes = Number(body.durationMinutes)
  if (!start || !Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    return NextResponse.json({ error: 'start (ISO) and positive durationMinutes required' }, { status: 400 })
  }

  const match = await prisma.match.findUnique({
    where: { id },
    select: {
      id: true, organizationId: true, counterpartType: true, counterpartId: true,
      reason: true, opportunityId: true, opportunityType: true,
    },
  })
  if (!match) return NextResponse.json({ error: 'match not found' }, { status: 404 })
  // Brief 35: never schedule across test data and a real homeowner.
  if (isMixedTestPair(...await matchSides(prisma, match))) return NextResponse.json(MIXED_TEST_PAIR, { status: 409 })

  // Brief 32 — supply may be an ExtractedOpportunity or a MojoContact seller.
  const opp = await resolveSupply(prisma, match.opportunityId, match.opportunityType)
  if (!opp) return NextResponse.json({ error: 'listing side not found' }, { status: 404 })
  // extractedSummary is opportunity-only (not on ResolvedSupply); fetch for the
  // event notes when the supply is an ExtractedOpportunity, else null.
  const extractedSummary = match.opportunityType !== 'contact'
    ? (await prisma.extractedOpportunity.findUnique({ where: { id: match.opportunityId }, select: { extractedSummary: true } }))?.extractedSummary ?? null
    : null
  const partyName = await counterpartName(match.counterpartType, match.counterpartId)

  const listingLabel = opp.address ?? opp.extractedTitle
  const subject = partyName ? `Showing: ${listingLabel} w/ ${partyName}` : `Showing: ${listingLabel}`

  // Brief 35: contact supply links to the CRM lead (or nowhere), never to
  // /opportunities/<MojoContact id>, which only resolves ExtractedOpportunity ids.
  const base = process.env.BASE_URL?.replace(/\/$/, '') ?? ''
  const link = match.opportunityType === 'contact'
    ? crmLeadUrl((await prisma.mojoContact.findUnique({ where: { id: opp.id }, select: { metadata: true } }))?.metadata)
    : `${base}/opportunities/${opp.id}`
  const notes = [
    extractedSummary,
    partyName ? `Party: ${partyName}` : null,
    match.reason ? `Match: ${match.reason}` : null,
    link ? `${match.opportunityType === 'contact' ? 'CRM' : 'DealFlow'}: ${link}` : null,
  ].filter(Boolean).join('\n')

  let endISO: string
  try { endISO = addMinutesToLocal(start, durationMinutes) }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }) }

  const startISO = /:\d{2}:\d{2}$/.test(start) ? start : `${start}:00`

  let eventId: string
  try {
    const created = await createCalendarEvent({
      subject,
      startISO,
      endISO,
      location: opp.address ?? undefined,
      notes,
    })
    eventId = created.id
  } catch (e) {
    return NextResponse.json({ error: `calendar write failed: ${(e as Error).message}` }, { status: 502 })
  }

  // Safety requirement: log every write to M365.
  await prisma.auditLog.create({
    data: {
      organizationId: match.organizationId,
      action: 'CALENDAR_WRITE',
      detailsJson: {
        matchId: id,
        eventId,
        opportunityId: opp.id,
        subject,
        startISO,
        endISO,
        durationMinutes,
        at: new Date().toISOString(),
      },
    },
  })

  return NextResponse.json({ ok: true, eventId })
}
