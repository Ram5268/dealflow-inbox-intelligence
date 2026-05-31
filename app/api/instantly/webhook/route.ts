export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'

// Receives webhook events from Instantly AI
// Events: reply_received, lead_marked_as_interested, email_opened, email_bounced, lead_unsubscribed, link_clicked
export async function POST(req: NextRequest) {
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
