export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import {
  DEVICE_LIMIT_MESSAGE, MAX_PUSH_DEVICES, deviceLabel, endpointFingerprint, parseSubscription, type PushDevice,
} from '@/lib/push/devices'

// Brief 48 (PR 5): at most MAX_PUSH_DEVICES (5) devices per organization get
// notifications, and Settings lists them with "Remove" [planner, Brief 48 §3 PR 5;
// Brief 46 P4: anyone could sign up any number of devices, and none could be seen
// or removed].
//   GET            → { devices: [{ id, label, addedAt, fingerprint }] }, oldest first.
//                    Never the push address or keys: the address is a private link
//                    to the device. The fingerprint lets Settings mark "This device".
//   POST           → signs a browser up (the Home page's Check In). A 6th new device
//                    gets 409 with a plain message; a device that's already stored can
//                    always sign up again, which refreshes its keys.
//   DELETE { id }  → { ok: true, removed: 0 | 1 }, only within the current organization.

async function readJson(req: NextRequest): Promise<unknown> {
  try { return await req.json() } catch { return null }
}

export async function GET() {
  const organizationId = await getCurrentOrgId()
  const rows = await prisma.pushSubscription.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, endpoint: true, createdAt: true },
  })
  const devices: PushDevice[] = await Promise.all(rows.map(async r => ({
    id: r.id,
    label: deviceLabel(r.endpoint),
    addedAt: r.createdAt.toISOString(),
    fingerprint: (await endpointFingerprint(r.endpoint)) ?? '',
  })))
  return NextResponse.json({ devices })
}

export async function POST(req: NextRequest) {
  const sub = parseSubscription(await readJson(req))
  if (!sub) return NextResponse.json({ error: 'Invalid subscription' }, { status: 400 })

  // A device that's already stored can always sign up again: its keys are refreshed.
  const refreshed = await prisma.pushSubscription.updateMany({
    where: { endpoint: sub.endpoint }, data: { p256dh: sub.p256dh, auth: sub.auth },
  })
  if (refreshed.count > 0) return NextResponse.json({ ok: true })

  const organizationId = await getCurrentOrgId()
  const full = () => NextResponse.json({ ok: false, error: DEVICE_LIMIT_MESSAGE }, { status: 409 })
  if (await prisma.pushSubscription.count({ where: { organizationId } }) >= MAX_PUSH_DEVICES) return full()
  const added = await prisma.pushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    create: { organizationId, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
    update: { p256dh: sub.p256dh, auth: sub.auth },
    select: { id: true },
  })
  // Sign-ups that arrive together can each pass the count above. If this one took
  // the organization past the limit, it comes back out [engineering precaution].
  if (await prisma.pushSubscription.count({ where: { organizationId } }) > MAX_PUSH_DEVICES) {
    await prisma.pushSubscription.deleteMany({ where: { id: added.id, organizationId } })
    return full()
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const body = await readJson(req)
  const id = body && typeof body === 'object' ? (body as { id?: unknown }).id : undefined
  if (typeof id !== 'string' || !id || id.length > 100) {
    return NextResponse.json({ ok: false, error: 'Choose a device to remove.' }, { status: 400 })
  }
  const organizationId = await getCurrentOrgId()
  const { count } = await prisma.pushSubscription.deleteMany({ where: { id, organizationId } })
  return NextResponse.json({ ok: true, removed: count })
}
