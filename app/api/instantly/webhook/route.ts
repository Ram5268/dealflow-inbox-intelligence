export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { isTestModeOnly } from '@/lib/config/testMode'
import { checkInstantlyWebhookToken } from '@/lib/auth/instantlyWebhook'

// Receives webhook events from Instantly AI
// Events: reply_received, lead_marked_as_interested, email_opened, email_bounced, lead_unsubscribed, link_clicked
//
// Brief 41.2 (PR C): fails closed. Until all three of these hold, it reads no
// body and touches no database:
//   1. INSTANTLY_ENROLL_ENABLED is exactly 'true' (the Brief 34 Instantly
//      switch). Otherwise 503. Instantly stays off (Ryan's instruction, Sep 24,
//      2026: nothing may call, text or email CRM leads while testing).
//   2. INSTANTLY_WEBHOOK_SECRET is set. Otherwise 503.
//   3. The request has the header `Authorization: Bearer <INSTANTLY_WEBHOOK_SECRET>`.
//      Otherwise 401. A token in the URL is not accepted.
// The secret and these refusals are an engineering precaution from the Oct 16,
// 2026 system-map review. Setup, only if Instantly is ever switched on: set
// INSTANTLY_WEBHOOK_SECRET in Vercel to a long random value, and give the
// Instantly webhook (API v2 POST /api/v2/webhooks, or PATCH an existing one)
// target_hook_url <app>/api/instantly/webhook and
// headers { "Authorization": "Bearer <the same value>" }.
export async function POST(req: NextRequest) {
  if (process.env.INSTANTLY_ENROLL_ENABLED !== 'true') {
    return NextResponse.json({ ok: false, error: 'Instantly is switched off (INSTANTLY_ENROLL_ENABLED), so this webhook accepts nothing.' }, { status: 503 })
  }
  const auth = checkInstantlyWebhookToken(req.headers.get('authorization'), process.env.INSTANTLY_WEBHOOK_SECRET)
  if (auth !== 200) {
    const error = auth === 503 ? 'INSTANTLY_WEBHOOK_SECRET is not set, so this webhook accepts nothing.' : 'Missing or wrong webhook token.'
    return NextResponse.json({ ok: false, error }, { status: auth })
  }
  if (isTestModeOnly()) return NextResponse.json({ ok: false, reason: 'TEST_MODE_ONLY is on' })
  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Instantly AI sends event data — field names vary by event type
  const email        = String(body.email ?? body.lead_email ?? body.to ?? '')
  const eventType    = String(body.event_type ?? body.type ?? body.event ?? '')
  const campaignId   = String(body.campaign_id ?? body.campaignId ?? '')
  const campaignName = String(body.campaign_name ?? body.campaignName ?? '')
  const payload      = body

  if (!email || !eventType) {
    return NextResponse.json({ error: 'Missing email or eventType' }, { status: 400 })
  }

  // Look up matching MojoContact by email
  const contact = await prisma.mojoContact.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true },
  })

  // Store the event
  const organizationId = await getCurrentOrgId()
  await prisma.instantlyEvent.create({
    data: {
      organizationId,
      email,
      contactId:   contact?.id ?? null,
      campaignId:  campaignId  || null,
      campaignName: campaignName || null,
      eventType,
      payload: payload as object,
    },
  })

  // Elevate contact status on high-signal events
  if (contact) {
    const highSignal = ['reply_received', 'lead_marked_as_interested']
    if (highSignal.includes(eventType)) {
      const newStatus = eventType === 'reply_received' ? 'Email Reply' : 'Email Interested'
      await prisma.mojoContact.update({
        where: { id: contact.id },
        data:  { status: newStatus, syncedAt: new Date() },
      })
    }
  }

  return NextResponse.json({ ok: true })
}
