export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { prisma } from '@/lib/prisma'
import { sendPushToOrg, vapidConfigured } from '@/lib/push/send'

// Brief 7.4 — Settings "Test" button. Sends a real push to this org's devices now.
export async function POST() {
  if (!vapidConfigured()) {
    return NextResponse.json({ ok: false, error: 'VAPID keys not configured on the server' }, { status: 503 })
  }
  const organizationId = await getCurrentOrgId()
  const delivered = await sendPushToOrg(organizationId, {
    title: '✅ DealFlow test',
    body:  'Push notifications are working.',
    url:   '/',
  })
  await prisma.auditLog.create({
    data: { organizationId, action: 'PUSH_SENT', detailsJson: { kind: 'test', delivered, at: new Date().toISOString() } },
  }).catch(() => {})

  if (delivered === 0) {
    return NextResponse.json({ ok: false, error: 'No active subscriptions delivered. Enable notifications on this device first.' }, { status: 200 })
  }
  return NextResponse.json({ ok: true, delivered })
}
