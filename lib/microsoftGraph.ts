// READ-ONLY Microsoft Graph service.
// Only GET requests are used here. No POST/PATCH/PUT/DELETE against Graph.

import { prisma } from './prisma'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

async function refreshAccessToken(refreshToken: string): Promise<string | null> {
  const clientId = process.env.AZURE_CLIENT_ID
  const clientSecret = process.env.AZURE_CLIENT_SECRET
  const tenant = process.env.AZURE_TENANT ?? 'common'

  if (!clientId || !clientSecret) return null

  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read offline_access',
      }),
    }
  )

  if (!res.ok) return null

  const tokens = await res.json()
  const { access_token, refresh_token: new_refresh, expires_in } = tokens
  const expiresAt = new Date(Date.now() + expires_in * 1000)

  // Save refreshed tokens back to DB
  await prisma.connectedMailbox.update({
    where: { id: 'runtime-token' },
    data: {
      accessTokenEncrypted: access_token,
      refreshTokenEncrypted: new_refresh ?? refreshToken,
      lastSyncAt: expiresAt,
      updatedAt: new Date(),
    },
  })

  return access_token
}

async function getToken(): Promise<string> {
  try {
    const record = await prisma.connectedMailbox.findUnique({
      where: { id: 'runtime-token' },
      select: {
        accessTokenEncrypted: true,
        refreshTokenEncrypted: true,
        lastSyncAt: true,
      },
    })

    if (record?.accessTokenEncrypted) {
      // Check if access token is expired (lastSyncAt stores expiry)
      const isExpired = record.lastSyncAt
        ? record.lastSyncAt.getTime() < Date.now() + 60_000 // refresh 1 min early
        : false

      if (!isExpired) {
        return record.accessTokenEncrypted
      }

      // Try to refresh using refresh token
      if (record.refreshTokenEncrypted) {
        const newToken = await refreshAccessToken(record.refreshTokenEncrypted)
        if (newToken) return newToken
      }

      // Access token may still work even if we think it's expired — try it
      return record.accessTokenEncrypted
    }
  } catch {
    // DB not ready — fall through to env var
  }

  const token = process.env.MICROSOFT_GRAPH_ACCESS_TOKEN
  if (!token) {
    throw new Error(
      'No Microsoft Graph token found. Go to Settings and click "Connect Outlook" to set up permanent access.'
    )
  }
  return token
}

async function graphGet<T>(path: string): Promise<T> {
  const token = await getToken()
  const url = `${GRAPH_BASE}${path}`

  const res = await fetch(url, {
    method: 'GET', // ONLY GET — never write to Graph
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })

  if (!res.ok) {
    const body = await res.text()
    if (res.status === 401) {
      throw new Error(
        'Microsoft Graph token expired. Go to Settings and click "Connect Outlook" to reconnect.'
      )
    }
    throw new Error(`Microsoft Graph error ${res.status}: ${body}`)
  }

  return res.json() as Promise<T>
}

export interface GraphUser {
  id: string
  displayName: string
  mail: string
  userPrincipalName: string
}

export interface GraphMessage {
  id: string
  subject: string
  from: {
    emailAddress: {
      name: string
      address: string
    }
  }
  receivedDateTime: string
  bodyPreview: string
  webLink: string
  hasAttachments?: boolean
  body?: {
    contentType: string
    content: string
  }
}

export interface GraphAttachment {
  id: string
  name: string
  contentType: string
  size: number
  contentBytes?: string // base64
}

export interface GraphMessageList {
  value: GraphMessage[]
  '@odata.nextLink'?: string
}

export async function getMe(): Promise<GraphUser> {
  return graphGet<GraphUser>('/me')
}

export async function testConnection(): Promise<{
  ok: boolean
  displayName?: string
  mail?: string
  userPrincipalName?: string
  id?: string
  error?: string
}> {
  try {
    const user = await getMe()
    return {
      ok: true,
      displayName: user.displayName,
      mail: user.mail,
      userPrincipalName: user.userPrincipalName,
      id: user.id,
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function getRecentMessages(
  top = 50,
  daysBack = 30
): Promise<GraphMessage[]> {
  const since = new Date()
  since.setDate(since.getDate() - daysBack)
  const sinceIso = since.toISOString()

  const select = 'id,subject,from,receivedDateTime,bodyPreview,webLink,hasAttachments,body'
  const filter = `receivedDateTime ge ${sinceIso}`
  const orderby = 'receivedDateTime desc'
  const path = `/me/messages?$select=${select}&$filter=${encodeURIComponent(filter)}&$orderby=${encodeURIComponent(orderby)}&$top=${top}`

  const result = await graphGet<GraphMessageList>(path)
  return result.value
}

export async function getMessageAttachments(messageId: string, maxBytes = 5 * 1024 * 1024): Promise<GraphAttachment[]> {
  // Fetch all attachments with contentBytes in a single call — no $select so Graph includes everything
  const result = await graphGet<{ value: GraphAttachment[] }>(
    `/me/messages/${encodeURIComponent(messageId)}/attachments`
  )
  return (result.value ?? []).map(att => ({
    ...att,
    // Clear contentBytes for oversized attachments to avoid memory issues
    contentBytes: att.size > maxBytes ? undefined : att.contentBytes,
  }))
}

export async function getMessageById(messageId: string): Promise<GraphMessage> {
  const select = 'subject,from,receivedDateTime,body,bodyPreview,webLink'
  return graphGet<GraphMessage>(`/me/messages/${messageId}?$select=${select}`)
}
