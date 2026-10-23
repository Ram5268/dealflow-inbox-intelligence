import { NYC_RE_BIAS_PROMPT } from '../transcription/prompt'
import { CANONICAL_NAMES } from '../domain/Neighborhood'

// Brief 36 — live transcription for voice mode. The browser POSTs its WebRTC
// SDP offer here; we add the session config and the real key server-side and
// return the SDP answer, so no key of any kind (not even an ephemeral one)
// reaches the client. Injectable deps keep it unit-testable without Prisma.

export const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls'
export const VOICE_SESSION_ACTION = 'VOICE_SESSION'
export const SESSIONS_PER_HOUR = 60
export const MAX_SDP_BYTES = 20_000
// Brief 43 PR 17: the new refusals, in lib/spendGuard.ts's shape (kept here so
// this module stays free of Prisma).
export const ADDRESS_LIMIT_MESSAGE = 'Voice mode has reached its hourly limit. Try again in a little while.'
export const DAILY_LIMIT_MESSAGE = 'Voice mode has reached its daily limit. It resets at midnight.'

const RE_TERMS = ['two-family', 'three-family', 'duplex', 'triplex', 'co-op', 'condo', 'multifamily']

// gpt-live-transcribe streams deltas while Ryan talks; it has no server VAD
// (turn_detection must be null), so the client's silero VAD commits each turn.
export function transcriptionSession() {
  const transcription = {
    model: 'gpt-live-transcribe', prompt: NYC_RE_BIAS_PROMPT, keywords: [...CANONICAL_NAMES, ...RE_TERMS], languages: ['en'], delay: 'low',
  }
  return { type: 'transcription', audio: { input: { noise_reduction: { type: 'near_field' }, transcription, turn_detection: null } } }
}

export interface VoiceSessionDeps {
  enabled: boolean; apiKey: string | undefined; fetchImpl?: typeof fetch; now?: () => number
  // Sessions since `since`, leaving out `exceptId` (this request's own row).
  countSessionsSince: (since: Date, exceptId?: string) => Promise<number>
  // Writes this request's VOICE_SESSION row and returns its id. Brief 43 PR 17
  // [engineering precaution]: it's written before anything is counted (reserve,
  // then count), so sessions opened all at once can't each read "under the
  // limit"; a refused request's row becomes its refusal row.
  logSession: () => Promise<string | void>
  // Brief 43 PR 17 [engineering precaution]: no login [Ryan, 2026-09-24], so
  // also a per-address cap inside the global 60 (one address can't use the
  // shared hour up by itself) and a daily total. Optional so the Brief 36
  // tests need no new fakes; the route always passes them.
  countAddressSessionsSince?: (since: Date, exceptId?: string) => Promise<number>
  sessionsPerAddressPerHour?: number
  dayStart?: Date // midnight New York time
  sessionsPerDay?: number // all addresses
  // Turns this request's row into its counts-only refusal row (or writes one).
  refuseSession?: (id: string | undefined, reason: string) => Promise<unknown>
}

const json = (body: object, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function handleVoiceSession(req: Request, deps: VoiceSessionDeps): Promise<Response> {
  if (!deps.enabled) return new Response('Not Found', { status: 404 })
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/sdp')) {
    return json({ error: 'Content-Type must be application/sdp' }, 415)
  }
  if (Number(req.headers.get('content-length') ?? 0) > MAX_SDP_BYTES) return json({ error: 'Offer too large' }, 413)
  const sdp = await req.text()
  if (Buffer.byteLength(sdp) > MAX_SDP_BYTES) return json({ error: 'Offer too large' }, 413)
  if (!sdp.trim()) return json({ error: 'Empty offer' }, 400)

  const now = deps.now?.() ?? Date.now()
  const hourAgo = new Date(now - 3_600_000)
  const id = (await deps.logSession()) || undefined
  let refusal: { reason: string; body: object; status: number } | null = null
  try {
    if ((await deps.countSessionsSince(hourAgo, id)) >= SESSIONS_PER_HOUR) {
      refusal = { reason: 'global_per_hour', body: { error: 'Voice mode has hit its hourly limit. Try again later.' }, status: 429 }
    } else if (deps.dayStart && deps.sessionsPerDay != null &&
        (await deps.countSessionsSince(deps.dayStart, id)) >= deps.sessionsPerDay) {
      refusal = { reason: 'daily_count', body: { error: 'spend_limit', message: DAILY_LIMIT_MESSAGE }, status: 429 }
    } else if (deps.countAddressSessionsSince && deps.sessionsPerAddressPerHour != null &&
        (await deps.countAddressSessionsSince(hourAgo, id)) >= deps.sessionsPerAddressPerHour) {
      refusal = { reason: 'ip_per_hour', body: { error: 'spend_limit', message: ADDRESS_LIMIT_MESSAGE }, status: 429 }
    }
  } catch (err) {
    // Fails closed, as before (a count error used to be a 500).
    console.error('[voice/session] limit check failed; refusing:', err instanceof Error ? err.message : err)
    refusal = { reason: 'guard_unavailable', body: { error: 'Voice service unavailable' }, status: 503 }
  }
  if (refusal) {
    await deps.refuseSession?.(id, refusal.reason)
    return json(refusal.body, refusal.status)
  }

  const form = new FormData()
  form.set('sdp', sdp)
  form.set('session', JSON.stringify(transcriptionSession()))
  try {
    const res = await (deps.fetchImpl ?? fetch)(REALTIME_CALLS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.apiKey}` },
      body: form,
    })
    const text = await res.text()
    if (!res.ok) {
      // Log server-side only; the client gets a generic message, never provider text.
      console.error('[voice/session] realtime handshake failed:', res.status, text.slice(0, 300))
      return json({ error: 'Voice service unavailable' }, 502)
    }
    return new Response(text, { status: 200, headers: { 'Content-Type': 'application/sdp', 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('[voice/session] realtime handshake error:', err)
    return json({ error: 'Voice service unavailable' }, 502)
  }
}
