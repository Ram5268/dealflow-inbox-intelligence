import { prisma } from './prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { getRecentMessages, getMessageAttachments } from './microsoftGraph'
import { classifyAndExtractEmail } from './ai'
import { ingestEmail } from './ingestion/ingestEmail'
import { queueItem as queueReviewItem } from './ingestion/reviewQueueManager'
import { parseAttachment } from './attachmentParser'
import { buildOpportunityText, upsertOpportunityEmbedding } from './embeddings'
import { runMatchmaking } from './matchmaking'
import { sendPushToAll } from './pushNotifications'
import { checkStreetEasyStatuses } from './streetEasyStatus'
import { Category, TransactionType } from '@prisma/client'
import type { ValidationFlag } from './ingestion/types'

async function isFeatureFlagEnabled(id: string): Promise<boolean> {
  try {
    const flag = await prisma.featureFlag.findUnique({ where: { id } })
    return flag?.enabled ?? false
  } catch {
    return false
  }
}

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

const VALID_CATEGORIES = new Set([
  'COMING_SOON_SALE','COMING_SOON_RENTAL','OFF_MARKET_SALE','ACTIVE_SALE_LISTING','RENTAL_LISTING',
  'BUYER_ISO','RENTER_INQUIRY','SELLER_LEAD','LANDLORD_LEAD',
  'DEVELOPMENT_INVENTORY','SPONSOR_UNIT','OPEN_HOUSE','PRICE_DROP','BACK_ON_MARKET',
  'MARKET_REPORT','REAL_ESTATE_EVENT','CLIENT_CONVERSATION','SHOWING_CONFIRMATION','NOISE',
])
const VALID_TX = new Set([
  'SALE','RENTAL','BUYER_NEED','RENTER_NEED','SELLER_LEAD','LANDLORD_LEAD','UNKNOWN',
])

export async function runIncrementalSync(): Promise<{
  fetched: number; newEmails: number; newOpps: number; skipped: boolean; matches?: number; error?: string
}> {
  try {
    const organizationId = await getCurrentOrgId()

    // Determine date range: 90 days on first run, incremental after
    const mostRecent = await prisma.rawEmail.findFirst({
      orderBy: { receivedDateTime: 'desc' },
      select: { receivedDateTime: true },
    })

    let messages
    if (!mostRecent) {
      // First ever sync — pull 90 days
      messages = await getRecentMessages(100, 90)
    } else {
      // Incremental — only fetch emails newer than what we have
      const since = mostRecent.receivedDateTime
      const daysSince = Math.ceil((Date.now() - since.getTime()) / (1000 * 60 * 60 * 24)) + 1
      messages = await getRecentMessages(100, Math.min(daysSince, 90))
      // Filter to only truly new ones
      messages = messages.filter(
        m => new Date(m.receivedDateTime) > since
      )
    }

    if (messages.length === 0) {
      return { fetched: 0, newEmails: 0, newOpps: 0, skipped: false }
    }

    // Read feature flags once at the start of the sync
    const useNewPipeline      = await isFeatureFlagEnabled('USE_STRUCTURED_INGESTION_PIPELINE')
    const useReviewEnforcement = await isFeatureFlagEnabled('USE_REVIEW_QUEUE_ENFORCEMENT')

    let newEmails = 0
    let newOpps = 0
    const newOppIds: string[] = []

    for (const msg of messages) {
      const exists = await prisma.rawEmail.findUnique({
        where: { graphMessageId: msg.id },
      })
      if (exists) continue

      // Strip HTML tags from body for plain text
      const rawBodyContent = msg.body?.content ?? null
      const bodyText = rawBodyContent
        ? rawBodyContent.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim()
        : null

      // Fetch and parse attachments — collect metadata for classifier
      let attachmentText: string | null = null
      const attachmentNames: string[] = []
      const attachmentMimeTypes: string[] = []
      // Phase 3D — cache attachment metadata + bytes for V2 ingestion. Bytes
      // are persisted into Attachment.contentBytes after the RawEmail row is
      // created so processAttachments can replay parsing without re-hitting
      // Microsoft Graph (decouples V2 from token freshness).
      type CachedAttachment = {
        name:          string
        mimeType:      string
        sizeBytes:     number | null
        extractedText: string | null
        contentBytes:  Uint8Array<ArrayBuffer> | null
      }
      const cachedAttachments: CachedAttachment[] = []

      // Prisma 7's Bytes column is strictly typed as Uint8Array<ArrayBuffer>.
      // Buffer is Uint8Array<ArrayBufferLike>, so we copy into a fresh
      // ArrayBuffer-backed view to satisfy the strict generic.
      const toPrismaBytes = (b64: string): Uint8Array<ArrayBuffer> => {
        const buf = Buffer.from(b64, 'base64')
        const ab  = new ArrayBuffer(buf.byteLength)
        const u8  = new Uint8Array(ab)
        u8.set(buf)
        return u8
      }

      if (msg.hasAttachments) {
        try {
          const attachments = await getMessageAttachments(msg.id)
          const parts: string[] = []
          for (const att of attachments) {
            attachmentNames.push(att.name ?? '')
            attachmentMimeTypes.push(att.contentType ?? '')

            const rawBytes: Uint8Array<ArrayBuffer> | null = att.contentBytes
              ? toPrismaBytes(att.contentBytes)
              : null
            let parsedText: string | null = null

            if (att.size > MAX_ATTACHMENT_BYTES) {
              parts.push(`[attachment: ${att.name} — too large to parse]`)
            } else if (att.contentBytes) {
              const text = await parseAttachment(att.name, att.contentType, att.contentBytes)
              if (text) {
                parts.push(`--- ${att.name} ---\n${text}`)
                parsedText = text
              }
            }

            cachedAttachments.push({
              name:          att.name ?? '',
              mimeType:      att.contentType ?? '',
              sizeBytes:     typeof att.size === 'number' ? att.size : null,
              extractedText: parsedText,
              contentBytes:  rawBytes,
            })
          }
          if (parts.length > 0) attachmentText = parts.join('\n\n')
        } catch (e) {
          console.error('[DealFlow sync] Attachment fetch error:', (e as Error).message)
        }
      }

      const raw = await prisma.rawEmail.create({
        data: {
          organizationId,
          graphMessageId: msg.id,
          subject: msg.subject ?? '(no subject)',
          senderName: msg.from?.emailAddress?.name ?? null,
          senderEmail: msg.from?.emailAddress?.address ?? null,
          receivedDateTime: new Date(msg.receivedDateTime),
          bodyPreview: msg.bodyPreview ?? null,
          bodyContent: bodyText,
          bodyContentType: 'text',
          attachmentsText: attachmentText,
          webLink: msg.webLink ?? null,
          rawJson: msg as object,
          processed: false,
        },
      })
      newEmails++

      // Phase 3D — persist Attachment rows so V2 ingestion (processAttachments)
      // can pick up the bytes without re-fetching from Graph. Failure to persist
      // one attachment must not block the rest of the email pipeline.
      for (const a of cachedAttachments) {
        try {
          await prisma.attachment.create({
            data: {
              organizationId,
              rawEmailId:    raw.id,
              name:          a.name,
              mimeType:      a.mimeType,
              sizeBytes:     a.sizeBytes,
              extractedText: a.extractedText,
              contentBytes:  a.contentBytes,
            },
          })
        } catch (e) {
          console.error('[DealFlow sync] Attachment row persist error:', (e as Error).message)
        }
      }

      try {
        // ── Pipeline selection ────────────────────────────────────────────────
        const results = useNewPipeline
          ? await ingestEmail({
              rawEmailId:          raw.id,
              subject:             raw.subject,
              senderName:          raw.senderName,
              senderEmail:         raw.senderEmail,
              bodyPreview:         raw.bodyPreview,
              bodyFirst500:        bodyText ? bodyText.slice(0, 500) : null,
              attachmentNames,
              attachmentMimeTypes,
              attachmentCount:     attachmentNames.length,
              fullBody:            bodyText,
              attachmentText,
            })
          : await classifyAndExtractEmail({
              subject:             raw.subject,
              senderName:          raw.senderName,
              senderEmail:         raw.senderEmail,
              receivedDateTime:    raw.receivedDateTime.toISOString(),
              bodyPreview:         raw.bodyPreview,
              fullBody:            bodyText,
              attachmentText,
            })

        for (const ext of results) {
          if (!ext.isRelevant || ext.category === 'NOISE') continue

          const category = VALID_CATEGORIES.has(ext.category) ? ext.category as Category : Category.NOISE
          if (category === Category.NOISE) continue
          const transactionType = VALID_TX.has(ext.transactionType) ? ext.transactionType as TransactionType : TransactionType.UNKNOWN

          const processingStatus = ext.processingStatus ?? 'active'

          const opp = await prisma.extractedOpportunity.create({
            data: {
              organizationId,
              rawEmailId: raw.id, category, transactionType,
              propertyType: ext.propertyType ?? null,
              address: ext.address ?? null, neighborhood: ext.neighborhood ?? null,
              borough: ext.borough ?? null, city: ext.city ?? null,
              state: ext.state ?? null, zip: ext.zip ?? null,
              price: ext.price ?? null, minPrice: ext.minPrice ?? null,
              maxPrice: ext.maxPrice ?? null, beds: ext.beds ?? null,
              baths: ext.baths ?? null, units: ext.units ?? null,
              squareFeet: ext.squareFeet ?? null, availabilityDate: ext.availabilityDate ?? null,
              sourceAgentName: ext.sourceAgentName ?? null, sourceAgentEmail: ext.sourceAgentEmail ?? null,
              sourceBrokerage: ext.sourceBrokerage ?? null, clientSide: ext.clientSide ?? null,
              status: ext.status ?? null, extractedTitle: ext.extractedTitle,
              extractedSummary: ext.extractedSummary, classificationReason: ext.classificationReason,
              confidenceScore: ext.confidenceScore,
              processingStatus,
              propertyId:    ext.propertyId    ?? null,
              duplicateOfId: (ext as unknown as { duplicateOfId?: string | null }).duplicateOfId ?? null,
              // Phase X.1 — SE auto-match results from ingestEmail. NULL when
              // the lookup didn't match, the API errored, or quota is paused.
              streetEasyId:        ext.streetEasyId        ?? null,
              streetEasyStatus:    ext.streetEasyStatus    ?? null,
              streetEasyCheckedAt: ext.streetEasyCheckedAt ?? null,
            },
          })
          newOpps++

          // Only add to matchmaking pool if the record is active (not flagged for review)
          if (processingStatus === 'active') newOppIds.push(opp.id)

          // Embed active records immediately; defer needs_review records until approved
          if (processingStatus === 'active') {
            upsertOpportunityEmbedding(opp.id, buildOpportunityText({ ...ext, ...opp })).catch(
              e => console.error('[DealFlow sync] Embedding error:', (e as Error).message)
            )
          }

          // Create CriteriaProfile for buyer ISOs and renter inquiries
          if (category === Category.BUYER_ISO || category === Category.RENTER_INQUIRY) {
            const cp = (ext as unknown as Record<string, unknown>)._criteriaProfile as Record<string, unknown> | undefined
            if (cp) {
              prisma.criteriaProfile.create({
                data: {
                  organizationId,
                  opportunityId: opp.id,
                  type:          (cp.type as string) ?? (category === Category.BUYER_ISO ? 'buyer' : 'renter'),
                  neighborhoods: Array.isArray(cp.neighborhoods) ? cp.neighborhoods as string[] : [],
                  borough:       (cp.borough as string | null) ?? null,
                  minPrice:      (cp.minPrice as number | null) ?? null,
                  maxPrice:      (cp.maxPrice as number | null) ?? null,
                  minBeds:       (cp.minBeds as number | null) ?? null,
                  maxBeds:       (cp.maxBeds as number | null) ?? null,
                  propertyTypes: Array.isArray(cp.propertyTypes) ? cp.propertyTypes as string[] : [],
                  notes:         (cp.notes as string | null) ?? null,
                  agentName:     (cp.agentName as string | null) ?? null,
                  agentEmail:    (cp.agentEmail as string | null) ?? null,
                  brokerage:     (cp.brokerage as string | null) ?? null,
                },
              }).catch(() => {})
            }
          }

          // Review queue (only when new pipeline + enforcement enabled)
          if (useNewPipeline && useReviewEnforcement && ext.flagReasons?.length) {
            const flags: ValidationFlag[] = ext.flagReasons.map(r => ({
              reason: r as ValidationFlag['reason'],
              severity: processingStatus === 'needs_review' ? 'block' : 'warning',
              message: r,
            }))
            queueReviewItem(opp.id, raw.id, flags).catch(() => {})
          }
        }

        await prisma.rawEmail.update({ where: { id: raw.id }, data: { processed: true } })
      } catch (e) {
        console.error('[DealFlow sync] Classification error:', (e as Error).message)
      }
    }

    await prisma.auditLog.create({
      data: {
        organizationId,
        action: 'BACKGROUND_SYNC',
        detailsJson: { fetched: messages.length, newEmails, newOpps, at: new Date().toISOString() },
      },
    })

    // Detect showing confirmations — create high-priority match records for calendar proposals
    const showingConfirmations = newOppIds.length > 0
      ? await prisma.extractedOpportunity.findMany({
          where: { id: { in: newOppIds }, category: Category.SHOWING_CONFIRMATION },
          select: { id: true, extractedTitle: true, address: true, availabilityDate: true, sourceAgentName: true },
        })
      : []

    for (const sc of showingConfirmations) {
      const reason = `Showing confirmation: ${sc.extractedTitle}${sc.address ? ' at ' + sc.address : ''}${sc.availabilityDate ? ' on ' + sc.availabilityDate : ''}. Add to your Outlook calendar?`
      await prisma.match.create({
        data: { organizationId, opportunityId: sc.id, counterpartId: sc.id, counterpartType: 'showing_confirmation', score: 90, reason },
      }).catch(() => {})
    }

    // Run matchmaking on new opportunities
    let matchCount = 0
    if (newOppIds.length > 0) {
      try {
        const matchResult = await runMatchmaking(newOppIds)
        matchCount = matchResult.total + showingConfirmations.length
        const totalHighConf = matchResult.highConfidence + showingConfirmations.length
        if (totalHighConf > 0) {
          const scText = showingConfirmations.length > 0 ? ` + ${showingConfirmations.length} showing confirmation${showingConfirmations.length > 1 ? 's' : ''}` : ''
          const body = `${matchResult.highConfidence} new match${matchResult.highConfidence !== 1 ? 'es' : ''}${scText} found`
          await sendPushToAll('DealFlow', body, '/').catch(() => {})
        }
      } catch (e) {
        console.error('[matchmaking] failed:', e)
        await prisma.auditLog.create({
          data: { organizationId, action: 'matchmaking_failed', detailsJson: { error: (e as Error).message, oppCount: newOppIds.length } },
        }).catch(() => {})
      }
    }

    // Check StreetEasy status on existing listings (background, non-blocking)
    checkStreetEasyStatuses(25).catch(e =>
      console.error('[DealFlow sync] StreetEasy status check error:', (e as Error).message)
    )

    return { fetched: messages.length, newEmails, newOpps, skipped: false, matches: matchCount }
  } catch (err) {
    const msg = (err as Error).message
    const isTokenError = msg.includes('expired') || msg.includes('not found') || msg.includes('401') || msg.includes('token')
    if (!isTokenError) {
      console.error('[DealFlow sync] Error:', msg)
    }
    return { fetched: 0, newEmails: 0, newOpps: 0, skipped: true, error: msg }
  }
}
