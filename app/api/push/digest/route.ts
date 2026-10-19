export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { sendPushToOrg } from '@/lib/push/send'
import { loadDismissedPairs } from '@/lib/matching/dismissals'
import { tierCounts } from '@/lib/push/digestCounts'
import { digestText } from '@/lib/push/digestText'
import { checkCronBearer } from '@/lib/auth/cronBearer'

// Brief 7.4 (A.1) — morning digest. Triggered by external cron (daily 8am ET =
// 12:00 UTC during EDT). Deployment-agnostic: prod DB is on Railway, so this is
// written to be hit by ANY external scheduler — vercel.json cron (default,
// committed) OR a Railway cron job pointing at the same URL. Protected by
// CRON_SECRET (Vercel cron sends `Authorization: Bearer <CRON_SECRET>`). Brief 41
// (L1): checkCronBearer, so it fails closed when the secret is unset, and the
// header is the only way in (no ?secret=).
//
// For each org with ≥1 push subscription: find today's un-dismissed matches and push
// a one-line digest of their counts; a tap opens the best (top HOT, else top-scored).
// Zero matches → a lighter "quiet morning" nudge. Every send is logged (action:
// PUSH_SENT).
//
// Brief 48 (PR 5): the text is counts only (lib/push/digestText.ts) [planner, Brief 48
// §3 PR 5]. It used to name the best match's buyer or homeowner and show the home's
// address; now nothing about either side is looked up. The quiet morning no longer
// says "Inbox synced Xd ago": email reading is paused [Ryan].

function startOfTodayUtc(): Date {
  const n = new Date()
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()))
}

interface DigestResult { organizationId: string; sent: boolean; delivered: number; reason?: string }

async function buildAndSend(organizationId: string): Promise<DigestResult> {
  const prefs = await prisma.notificationPreferences.findUnique({
    where: { organizationId }, select: { digestEnabled: true },
  })
  if (prefs && !prefs.digestEnabled) return { organizationId, sent: false, delivered: 0, reason: 'digest disabled' }

  // Today's un-dismissed matches (dismissal lookup chunked, Brief 35).
  const since = startOfTodayUtc()
  const todays = await prisma.match.findMany({
    where: { organizationId, createdAt: { gte: since }, counterpartType: { not: 'showing_confirmation' } },
    orderBy: [{ tier: 'asc' }, { score: 'desc' }],  // tier asc puts HOT first (enum order HOT<WARM<POSSIBLE)
    select: { id: true, tier: true, score: true, counterpartId: true, opportunityId: true },
  })

  let matches = todays
  if (todays.length > 0) {
    const isDismissed = await loadDismissedPairs(prisma, todays)
    matches = todays.filter(m => !isDismissed(m))
  }

  const text = digestText(tierCounts(matches)) // Brief 35: one tier per match, never negative

  if (matches.length === 0) {
    const delivered = await sendPushToOrg(organizationId, { ...text, url: '/matches' })
    await logSend(organizationId, delivered, 0)
    return { organizationId, sent: delivered > 0, delivered, reason: 'quiet' }
  }

  // Best match: list is already ordered HOT-first then score desc. Its id is only in
  // the link, never in the text.
  const delivered = await sendPushToOrg(organizationId, { ...text, url: `/matches?m=${matches[0].id}` })
  await logSend(organizationId, delivered, matches.length)
  return { organizationId, sent: delivered > 0, delivered }
}

async function logSend(organizationId: string, delivered: number, matchCount: number) {
  await prisma.auditLog.create({
    data: {
      organizationId,
      action: 'PUSH_SENT',
      detailsJson: { kind: 'digest', delivered, matchCount, at: new Date().toISOString() },
    },
  }).catch(() => {})
}

async function run(req: NextRequest) {
  const auth = checkCronBearer(req.headers.get('authorization'), process.env.CRON_SECRET)
  if (auth !== 200) {
    return NextResponse.json({ error: auth === 500 ? 'CRON_SECRET not configured' : 'unauthorized' }, { status: auth })
  }

  // Every org that has at least one push subscription.
  const orgs = await prisma.pushSubscription.findMany({ select: { organizationId: true }, distinct: ['organizationId'] })
  const results: DigestResult[] = []
  for (const { organizationId } of orgs) {
    try { results.push(await buildAndSend(organizationId)) }
    catch (e) { results.push({ organizationId, sent: false, delivered: 0, reason: (e as Error).message }) }
  }
  return NextResponse.json({ ok: true, orgs: results.length, results })
}

export async function GET(req: NextRequest)  { return run(req) }
export async function POST(req: NextRequest) { return run(req) }
