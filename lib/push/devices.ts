// Brief 48 (PR 5): the devices that get push notifications [planner, Brief 48 §3
// PR 5; Brief 46 P4: anyone could sign up any number of devices, and none could be
// seen or removed]. Shared by /api/push/subscribe and the Settings device list
// (components/settings/PushDevices.tsx), so nothing here touches the database or
// anything server-only. Pure, so it is unit-tested.

// At most this many devices per organization get notifications [planner, Brief 48 §3 PR 5].
export const MAX_PUSH_DEVICES = 5

export const DEVICE_LIMIT_MESSAGE =
  `${MAX_PUSH_DEVICES} devices already get notifications, the most allowed. Remove one in Settings, then try again.`

export const NO_DEVICES_MESSAGE = 'No devices get notifications yet. Turn them on with Check In on the Home page.'

// One device as GET /api/push/subscribe returns it. Never the push address or keys:
// the address is a private link to the device.
export interface PushDevice {
  id: string
  label: string
  addedAt: string // ISO
  fingerprint: string
}

// A plain name for the browser behind a device, from its push service's host. The
// host must be the service's own domain or a subdomain of it, so a look-alike host
// is just "Browser".
const SERVICES: Array<[domain: string, label: string]> = [
  ['push.apple.com', 'iPhone, iPad or Mac (Safari)'],
  ['googleapis.com', 'Chrome or Android'],
  ['mozilla.com', 'Firefox'],
  ['notify.windows.com', 'Edge'],
]
export function deviceLabel(endpoint: string): string {
  let host: string
  try { host = new URL(endpoint).hostname.toLowerCase() } catch { return 'Browser' }
  for (const [domain, label] of SERVICES) if (host === domain || host.endsWith(`.${domain}`)) return label
  return 'Browser'
}

// The first 12 hex characters of the SHA-256 of a device's push address: enough to
// tell this device from the others, without the address. Web Crypto, so the server
// and the browser compute the same value. Null where it's missing (a page that isn't
// served over https).
const FINGERPRINT_LENGTH = 12
export async function endpointFingerprint(
  endpoint: string,
  subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null,
): Promise<string | null> {
  if (!subtle) return null
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('').slice(0, FINGERPRINT_LENGTH)
}

// What a sign-up must look like: what a browser's PushSubscription gives, an https
// push address and both keys, within sane lengths. Anything else is refused
// [engineering precaution: the sign-up address is open to anyone, and the server
// later sends to whatever address is stored].
export interface NewSubscription { endpoint: string; p256dh: string; auth: string }
const MAX_ENDPOINT_CHARS = 2048
const MAX_KEY_CHARS = 512
export function parseSubscription(body: unknown): NewSubscription | null {
  if (!body || typeof body !== 'object') return null
  const { endpoint, keys } = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } | null }
  const p256dh = keys?.p256dh
  const auth = keys?.auth
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT_CHARS) return null
  if (typeof p256dh !== 'string' || !p256dh || p256dh.length > MAX_KEY_CHARS) return null
  if (typeof auth !== 'string' || !auth || auth.length > MAX_KEY_CHARS) return null
  try { if (new URL(endpoint).protocol !== 'https:') return null } catch { return null }
  return { endpoint, p256dh, auth }
}

// The Settings rows. "This device" is the row whose fingerprint matches this
// browser's own push sign-up; with no sign-up, or no push support, no row is marked.
// The date added is the New York calendar day.
export interface DeviceRow { id: string; label: string; added: string; isThisDevice: boolean }
const ADDED = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })
export function deviceRows(devices: PushDevice[], thisFingerprint: string | null): DeviceRow[] {
  return devices.map(d => {
    const t = Date.parse(d.addedAt)
    return {
      id: d.id,
      label: d.label,
      added: Number.isNaN(t) ? '' : `Added ${ADDED.format(t)}`,
      isThisDevice: !!thisFingerprint && d.fingerprint === thisFingerprint,
    }
  })
}

// The line under the list (or in place of it, with no devices).
export function devicesNote(count: number): string {
  if (count <= 0) return NO_DEVICES_MESSAGE
  if (count < MAX_PUSH_DEVICES) return `Up to ${MAX_PUSH_DEVICES} devices can get notifications.`
  return "That's the most devices allowed. Remove one before adding another."
}
