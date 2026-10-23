// Brief 41 (H10) — the code-level off-switch for Microsoft Graph / Outlook.
//
// Outlook is on a hard compliance pause. Nothing may read, refresh, install or
// use a Microsoft token unless GRAPH_ENABLED is exactly 'true'. It fails closed:
// unset, empty, 'TRUE', '1' or a typo all mean OFF. Do not set it while the
// pause stands. Pure (no Prisma, no fetch) so it's unit-tested directly; the
// DB and network pieces are passed in by lib/microsoftGraph.ts.

export function graphEnabled(): boolean {
  return process.env.GRAPH_ENABLED === 'true'
}

export const GRAPH_PAUSED_MESSAGE = 'Outlook is paused, so DealFlow is not connecting to it.'

export class GraphDisabledError extends Error {
  constructor() {
    super(GRAPH_PAUSED_MESSAGE)
    this.name = 'GraphDisabledError'
  }
}

// JSON body for routes that refuse while the switch is off.
export const GRAPH_PAUSED_BODY = { ok: false, paused: true, error: GRAPH_PAUSED_MESSAGE } as const

// Drift's context block while the switch is off (lib/chat/context/calendar.ts),
// on every turn. Brief 43 PR 14: D8 [Brief 42 default], calendar off, so Drift
// says so and keeps the details in chat (DRIFT_SCRIPT #24 wording). The reply
// tool has no pendingEvent field while the switch is off (Q33).
export const GRAPH_PAUSED_CALENDAR_BLOCK =
  "\n\nCALENDAR: Outlook is paused, so you can't see or add calendar events right now. Never offer to book or schedule anything. If asked what's on the calendar, say you can't see it right now. If asked to book something, say \"Your calendar isn't connected right now, so I can't book it. I'll keep the details here:\" and then give what, where, the day and the time in one line, so they stay in the chat."

// Brief 43 PR 14 (dormant until Outlook returns): only while the switch is on,
// Drift proposes an event and Ryan's plain yes books it (lib/chat/calendarConfirm.ts).
export const GRAPH_ON_CALENDAR_NOTE =
  "\n\nCALENDAR: To book something, propose it in pendingEvent and wait for Ryan's plain yes. Never say it's booked until a calendar confirmation appears in the conversation."

// Brief 43 PR 14 (Q29, M21): email comes in through Outlook too, so while the
// switch is off nothing new arrives. Drift is told so on every turn, with the
// date of the newest email on file (null when there is none).
export function graphPausedEmailBlock(newestEmailAt: Date | null): string {
  const base = '\n\nEMAIL: Email reading is paused (Outlook is off), so no new emails, listings or buyer requests are coming in from email.'
  if (!newestEmailAt) return `${base} If asked what came in, say that plainly.`
  const long = newestEmailAt.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' })
  const short = newestEmailAt.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric' })
  return `${base} The newest email on file arrived on ${long}. If asked what came in today or this week, or how many came in, say that plainly first: "Email reading is paused, so nothing new has come in since ${short}."`
}

export interface StoredGraphToken {
  accessTokenEncrypted: string | null
  refreshTokenEncrypted: string | null
  lastSyncAt: Date | null // stores the access token's expiry
}

export interface GraphTokenDeps {
  loadStored: () => Promise<StoredGraphToken | null>
  refresh: (refreshToken: string) => Promise<string | null>
  envToken: () => string | undefined
  now: () => number
}

// The token lookup getToken() runs. With the switch off it throws before any
// dependency is touched: no DB read, no refresh call, no stale or env fallback.
export async function resolveGraphToken(deps: GraphTokenDeps): Promise<string> {
  if (!graphEnabled()) throw new GraphDisabledError()

  try {
    const record = await deps.loadStored()
    if (record?.accessTokenEncrypted) {
      // lastSyncAt stores the expiry; refresh 1 min early.
      const isExpired = record.lastSyncAt ? record.lastSyncAt.getTime() < deps.now() + 60_000 : false
      if (!isExpired) return record.accessTokenEncrypted

      if (record.refreshTokenEncrypted) {
        const fresh = await deps.refresh(record.refreshTokenEncrypted)
        if (fresh) return fresh
      }

      // Access token may still work even if we think it's expired — try it
      return record.accessTokenEncrypted
    }
  } catch {
    // DB not ready — fall through to env var
  }

  const token = deps.envToken()
  if (!token) {
    throw new Error(
      'No Microsoft Graph token found. Go to Settings and click "Connect Outlook" to set up permanent access.'
    )
  }
  return token
}
