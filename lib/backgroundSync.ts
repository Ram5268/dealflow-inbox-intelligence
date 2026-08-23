import { prisma } from './prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { getRecentMessages, getMessageAttachments } from './microsoftGraph'
import { classifyAndExtractEmail } from './ai'
import { ingestEmail } from './ingestion/ingestEmail'
import { queueItem as queueReviewItem } from './ingestion/reviewQueueManager'
import { parseAttachment } from './attachmentParser'
import { buildOpportunityText, upsertOpportunityEmbedding } from './embeddings'
import { findMatchesForListing, findMatchesForParty } from './matching/engine'
import { resolveSupply } from './matching/supplyResolver'
import { isMatchingTestModeOnly } from './config/matchingTestMode'
import { SUPPLY_SALE, SUPPLY_RENTAL } from './domain/Categories'
import { sendPushToAll } from './pushNotifications'
import { maybeFireHotAlert } from './push/hotAlert'
import { formatPriceRange } from './utils'
import { checkStreetEasyStatuses } from './streetEasyStatus'
import { Category, MatchTier, TransactionType } from '@prisma/client'
import type { ValidationFlag } from './ingestion/types'

// Brief 7.2 (Fix #9) — persistence adapter for the 7.0 matching engine.
// The engine (findMatchesForListing / findMatchesForParty) is a pure query
// surface — it scores but doesn't write. The classic runMatchmaking() used to
// persist Match rows that the push + HOT-alert paths (and the UI) rely on, so
// we persist the engine's results here. The engine returns a tier, not a
// numeric score; we map tier → score so the existing score>=90 HOT query fires.
const SUPPLY_SET = new Set<Category>([...SUPPLY_SALE, ...SUPPLY_RENTAL])
const TIER_SCORE: Record<'Hot' | 'Warm' | 'Possible', number> = { Hot: 90, Warm: 70, Possible: 50 }
const TIER_ENUM: Record<'Hot' | 'Warm' | 'Possible', MatchTier> = {
  Hot: MatchTier.HOT, Warm: MatchTier.WARM, Possible: MatchTier.POSSIBLE,
}

async function runEngineMatches(
  organizationId: string,
  newOppIds: string[],
): Promise<{ total: number; highConfidence: number }> {
  const opps = await prisma.extractedOpportunity.findMany({
    where: { id: { in: newOppIds } },
    select: { id: true, category: true },
  })
  let total = 0
  let highConfidence = 0

  for (const opp of opps) {
    const isListing = SUPPLY_SET.has(opp.category)
    const isParty = opp.category === Category.BUYER_ISO || opp.category === Category.RENTER_INQUIRY
    if (!isListing && !isParty) continue // seller/landlord leads etc. have no supply-side match

    const result = isListing
      ? await findMatchesForListing(opp.id)
      : await findMatchesForParty(opp.id)

    for (const m of result.results) {
      // The counterpart is whichever side is not the just-created opportunity.
      const counterpartId = isListing ? m.party.id : m.listing.id
      const counterpartType = isListing && m.sourceBadge === 'mojo' ? 'mojo' : 'opportunity'
      const score = TIER_SCORE[m.tier]
      const tier = TIER_ENUM[m.tier]
      try {
        await prisma.match.upsert({
          where: {
            opportunityId_counterpartId_counterpartType: {
              opportunityId: opp.id, counterpartId, counterpartType,
            },
          },
          create: { organizationId, opportunityId: opp.id, counterpartId, counterpartType, score, reason: m.reason, tier },
          update: { score, reason: m.reason, tier },
        })
        total++
        if (m.tier === 'Hot') highConfidence++
      } catch { /* FK/conflict — skip this pair, keep going */ }
    }
  }
  return { total, highConfidence }
}

// Brief 7.4 — resolve a HOT match's counterpart display name for the push body.
async function hotPartyName(counterpartType: string, counterpartId: string): Promise<string | null> {
  if (counterpartType === 'mojo') {
    const c = await prisma.mojoContact.findUnique({ where: { id: counterpartId }, select: { fullName: true } })
    return c?.fullName ?? null
  }
  if (counterpartType === 'opportunity') {
    const c = await prisma.extractedOpportunity.findUnique({ where: { id: counterpartId }, select: { sourceAgentName: true, extractedTitle: true } })
    return c ? (c.sourceAgentName ?? c.extractedTitle) : null
  }
  return null
}

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
        // V1 ingestion is rollback-only. With INGEST_V2=true (the production
        // default in .env) only the V2 path runs (fired from the sync route),
        // so V1 no longer writes schema_validation_failed stubs daily. To roll
        // back: set INGEST_V2=false in .env and restart the server — V1 then
        // resumes here unconditionally. V1 code (ingestEmail, extractors,
        // validator, reviewQueueManager) is left fully intact.
        const results = process.env.INGEST_V2 === 'true'
          ? []
          : useNewPipeline
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

          // Phase 4.0.7 — fold buyer-ISO / renter-inquiry criteria onto the
          // opportunity row's own columns (the CriteriaProfile table is
          // deprecated). borough/minPrice/maxPrice were already set on create.
          if (category === Category.BUYER_ISO || category === Category.RENTER_INQUIRY) {
            const cp = (ext as unknown as Record<string, unknown>)._criteriaProfile as Record<string, unknown> | undefined
            if (cp) {
              prisma.extractedOpportunity.update({
                where: { id: opp.id },
                data: {
                  neighborhoods:  Array.isArray(cp.neighborhoods) ? cp.neighborhoods as string[] : [],
                  propertyTypes:  Array.isArray(cp.propertyTypes) ? cp.propertyTypes as string[] : [],
                  minBeds:        (cp.minBeds as number | null) ?? null,
                  maxBeds:        (cp.maxBeds as number | null) ?? null,
                  // V1 combined mustHaves/dealbreakers/timeline into `notes`.
                  mustHaves:      (cp.notes as string | null) ?? null,
                  criteriaActive: true,
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

    // Run matchmaking on new opportunities.
    // Brief 7.2 (Fix #9) — the classic runMatchmaking() is dead; the 7.0 engine
    // is the single matcher. Gated behind MATCHING_TEST_MODE_ONLY until the
    // follow-up flip, so live data stays isolated exactly as
    // lib/config/matchingTestMode.ts documents.
    let matchCount = showingConfirmations.length
    let newMatchHigh = 0
    if (newOppIds.length > 0 && !isMatchingTestModeOnly()) {
      try {
        const engineRes = await runEngineMatches(organizationId, newOppIds)
        matchCount += engineRes.total
        newMatchHigh = engineRes.highConfidence
      } catch (e) {
        console.error('[matchmaking] failed:', e)
        await prisma.auditLog.create({
          data: { organizationId, action: 'matchmaking_failed', detailsJson: { error: (e as Error).message, oppCount: newOppIds.length } },
        }).catch(() => {})
      }
    }

    // Push notification (showing-confirmation pushes fire regardless of the gate).
    const totalHighConf = newMatchHigh + showingConfirmations.length
    if (totalHighConf > 0) {
      const scText = showingConfirmations.length > 0 ? ` + ${showingConfirmations.length} showing confirmation${showingConfirmations.length > 1 ? 's' : ''}` : ''
      const body = `${newMatchHigh} new match${newMatchHigh !== 1 ? 'es' : ''}${scText} found`
      await sendPushToAll('DealFlow', body, '/').catch(() => {})
    }

    // Brief 7.4 (A.2) — realtime HOT alert. "hot" = score >= 90 (the GOLD band).
    // Fire for the single best just-created match; hotAlert owns the prefs check
    // + 5/hr rate limit. Returns null when no Match rows were written (gated / no hits).
    const topHot = newOppIds.length > 0 ? await prisma.match.findFirst({
      where: {
        organizationId,
        score: { gte: 90 },
        counterpartType: { not: 'showing_confirmation' },
        OR: [{ opportunityId: { in: newOppIds } }, { counterpartId: { in: newOppIds } }],
      },
      orderBy: { score: 'desc' },
      select: { id: true, counterpartType: true, counterpartId: true, opportunityId: true, opportunityType: true },
    }) : null
    // Brief 32 — resolve the supply (listing) side through the shared helper; it
    // may be an ExtractedOpportunity or a MojoContact seller.
    const opp = topHot ? await resolveSupply(prisma, topHot.opportunityId, topHot.opportunityType) : null
    if (topHot && opp) {
      const partyName = await hotPartyName(topHot.counterpartType, topHot.counterpartId)
      const listingLabel = [opp.address ?? opp.extractedTitle, formatPriceRange(opp.minPrice, opp.maxPrice, opp.price), opp.neighborhood].filter(Boolean).join(' ').trim()
      await maybeFireHotAlert({ organizationId, matchId: topHot.id, partyName: partyName ?? 'New match', listingLabel }).catch(() => {})
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
