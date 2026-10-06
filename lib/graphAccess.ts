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
