import { safeEqual } from './safeEqual'

// Brief 34: fail-closed auth for cron routes. Returns 500 when CRON_SECRET isn't
// configured and 401 on a missing or wrong token. Accepts the Authorization
// header only, never a ?secret= query param.
// Brief 48 (PR 6): the compare hashes both sides first (safeEqual), so a token
// of the wrong length takes the same path as one of the right length and the
// timing doesn't reveal the secret's length [engineering precaution].
export function checkCronBearer(authorization: string | null, secret: string | undefined): 200 | 401 | 500 {
  if (!secret) return 500
  return safeEqual(authorization ?? '', `Bearer ${secret}`) ? 200 : 401
}
