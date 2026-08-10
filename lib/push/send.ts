import webpush from 'web-push'
import { prisma } from '@/lib/prisma'

// Brief 7.4 — shared Web Push sender. Wraps web-push VAPID config once and
// prunes expired subscriptions (410/404) as a side effect. The legacy
// lib/pushNotifications.ts still exists for the aggregate "N new matches" ping in
// backgroundSync; this module is the granular path used by the digest, the
// realtime HOT alert, and the Settings test button.

export interface PushPayload {
  title: string
  body: string
  url?: string
}

let configured = false
function ensureVapid(): boolean {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return false
  if (!configured) {
    webpush.setVapidDetails(
      process.env.VAPID_EMAIL ?? 'mailto:admin@dealflow.app',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY,
    )
    configured = true
  }
  return true
}

interface SubRow { endpoint: string; p256dh: string; auth: string }

async function sendToSub(sub: SubRow, payload: PushPayload): Promise<boolean> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify({ url: '/', ...payload }),
    )
    return true
  } catch (err: unknown) {
    const status = (err as { statusCode?: number }).statusCode
    if (status === 410 || status === 404) {
      // Subscription expired — prune it so the digest/rate-limit counts stay honest.
      await prisma.pushSubscription.delete({ where: { endpoint: sub.endpoint } }).catch(() => {})
    }
    return false
  }
}

// Send one payload to every subscription in an org. Returns how many delivered.
export async function sendPushToOrg(organizationId: string, payload: PushPayload): Promise<number> {
  if (!ensureVapid()) return 0
  const subs = await prisma.pushSubscription.findMany({
    where: { organizationId },
    select: { endpoint: true, p256dh: true, auth: true },
  })
  let delivered = 0
  for (const sub of subs) {
    if (await sendToSub(sub, payload)) delivered++
  }
  return delivered
}

export function vapidConfigured(): boolean {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
}
