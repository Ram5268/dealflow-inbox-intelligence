import { timingSafeEqual } from 'crypto'

// Brief 34: fail-closed auth for cron routes. Returns 500 when CRON_SECRET isn't
// configured and 401 on a missing or wrong token. Accepts the Authorization
// header only, never a ?secret= query param.
export function checkCronBearer(authorization: string | null, secret: string | undefined): 200 | 401 | 500 {
  if (!secret) return 500
  const got = Buffer.from(authorization ?? '')
  const want = Buffer.from(`Bearer ${secret}`)
  return got.length === want.length && timingSafeEqual(got, want) ? 200 : 401
}
