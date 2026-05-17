import webpush from 'web-push'
import { prisma } from './prisma'

export async function sendPushToAll(title: string, body: string, url = '/') {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return

  webpush.setVapidDetails(
    process.env.VAPID_EMAIL ?? 'mailto:admin@dealflow.app',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  )

  const subs = await prisma.pushSubscription.findMany()
  const payload = JSON.stringify({ title, body, url })

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      )
    } catch (err: unknown) {
      // Subscription expired or invalid — remove it
      const status = (err as { statusCode?: number }).statusCode
      if (status === 410 || status === 404) {
        await prisma.pushSubscription.delete({ where: { endpoint: sub.endpoint } }).catch(() => {})
      }
    }
  }
}
