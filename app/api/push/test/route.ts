export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { prisma } from '@/lib/prisma'
import { sendPushToOrg, vapidConfigured } from '@/lib/push/send'

// Brief 7.4 — Settings "Test" button. Sends a real push to this org's devices now.
//
// Brief 48 (PR 5): at most one test a minute per organization [planner, Brief 48 §3
// PR 5; Brief 46 P4: anyone could ping every device in a loop]. The test's own
// PUSH_SENT row (kind 'test') is the record, so there's no new table.
// [engineering precaution] The row is written before the send, and a press that then
// finds another test from the last minute takes its row back out and gets 429, so
// presses that arrive together still send only one. A test that reached no device
// doesn't use up the minute, so "turn notifications on, then test again" works
// straight away.
const TEST_WINDOW_MS = 60_000

export async function POST() {
  if (!vapidConfigured()) {
    return NextResponse.json({ ok: false, error: "Notifications aren't set up on the server yet." }, { status: 503 })
  }
  const organizationId = await getCurrentOrgId()
  const at = new Date().toISOString()
  const mine = await prisma.auditLog.create({
    data: { organizationId, action: 'PUSH_SENT', detailsJson: { kind: 'test', at } },
    select: { id: true },
  })
  const lastMinute = await prisma.auditLog.findMany({
    where: {
      organizationId, action: 'PUSH_SENT', createdAt: { gte: new Date(Date.now() - TEST_WINDOW_MS) },
      detailsJson: { path: ['kind'], equals: 'test' },
    },
    select: { id: true, detailsJson: true },
  })
  // Another test: one still sending (no count yet), or one that reached a device.
  const another = lastMinute.some(r => r.id !== mine.id && (r.detailsJson as { delivered?: unknown } | null)?.delivered !== 0)
  if (another) {
    await prisma.auditLog.delete({ where: { id: mine.id } }).catch(() => {})
    return NextResponse.json({ ok: false, error: 'You can send one test a minute. Try again shortly.' }, { status: 429 })
  }

  const delivered = await sendPushToOrg(organizationId, {
    title: '✅ DealFlow test',
    body:  'Push notifications are working.',
    url:   '/',
  })
  await prisma.auditLog.update({
    where: { id: mine.id }, data: { detailsJson: { kind: 'test', delivered, at } },
  }).catch(() => {})

  if (delivered === 0) {
    return NextResponse.json({ ok: false, error: 'No device got the test. Turn on notifications with Check In on the Home page first.' }, { status: 200 })
  }
  return NextResponse.json({ ok: true, delivered })
}
