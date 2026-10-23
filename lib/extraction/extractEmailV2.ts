// Phase 4.0 — V2 extraction. Reads the DocumentChunks produced by the V2
// ingestion orchestrator (email_body / linked_html / pdf_text / pdf_table /
// inline_image), runs Claude Sonnet in forced tool_use mode for the email's
// category, and writes clean ExtractedOpportunity rows.
//
// This RETIRES the V1 stub pattern: V2 either extracts cleanly or skips. It
// NEVER writes a needs_review stub or a schema_validation_failed ReviewQueueItem
// (those are exactly what produced the 681-row backlog).
//
// Idempotency: prior ExtractedOpportunity rows (and their cascade-linked Match
// rows, plus the schema_validation_failed ReviewQueueItem rows) are wiped and
// replaced INSIDE the same transaction as the insert, and
// ONLY on a successful extraction. A failed/empty extraction is non-destructive
// — it leaves any existing review-queue entry intact (per the Phase 4 decision
// tree's "on failure: leave it").
import { prisma } from '../prisma'
import { Category, TransactionType, type ExtractedOpportunity } from '@prisma/client'
import { EXTRACTION_SPEC_BY_CATEGORY, type MapCtx, type OppRowData, type ExtractionSpec } from './schemas'
import { extractWithSonnet, type SonnetUsage } from './sonnetExtractor'
import { buildOpportunityText, upsertOpportunityEmbedding } from '../embeddings'
import { deleteListingsAndMatches, matchesOfListings } from './listingMatches'

const VALID_CATEGORY = new Set<string>(Object.values(Category))
const VALID_TX = new Set<string>(Object.values(TransactionType))

// Sonnet 4.6 pricing (USD per token).
const PRICE = {
  input:         3.0 / 1_000_000,
  output:        15.0 / 1_000_000,
  cacheRead:     0.30 / 1_000_000,
  cacheCreation: 3.75 / 1_000_000,
}

// Soft cap on the assembled chunk context (~15k tokens). Pathologically large
// multi-page PDFs are truncated with a logged note rather than silently.
const MAX_CONTEXT_CHARS = 60_000

export interface ChunkRow {
  chunkType:              string
  content:                string
  pageNumber:             number | null
  sectionHeading:         string | null
  hasTable:               boolean
  parentAttachmentId:     string | null
  parentLinkedResourceId: string | null
}

export function buildContext(
  email: { subject: string; senderName: string | null; senderEmail: string | null; receivedDateTime: Date },
  chunks: ChunkRow[],
  attachmentNames: Map<string, string>,
  linkedUrls: Map<string, string>,
): { text: string; truncated: boolean } {
  const parts: string[] = []
  parts.push(
    `Subject: ${email.subject}`,
    `From: ${email.senderName ?? 'Unknown'} <${email.senderEmail ?? ''}>`,
    `Received: ${email.receivedDateTime.toISOString()}`,
  )

  const byType = (t: string) => chunks.filter(c => c.chunkType === t)

  // Email body
  const body = byType('email_body')
  if (body.length) {
    parts.push('\n=== EMAIL BODY ===')
    for (const c of body) parts.push(c.content)
  }

  // Linked HTML, grouped by source URL
  const linked = byType('linked_html')
  if (linked.length) {
    const groups = new Map<string, ChunkRow[]>()
    for (const c of linked) {
      const key = c.parentLinkedResourceId ?? '(unknown)'
      ;(groups.get(key) ?? groups.set(key, []).get(key)!).push(c)
    }
    for (const [resId, list] of groups) {
      const url = linkedUrls.get(resId) ?? 'linked page'
      parts.push(`\n=== LINKED PAGE: ${url} ===`)
      for (const c of list) parts.push(c.content)
    }
  }

  // PDF text + tables, grouped by attachment then page
  const pdf = chunks.filter(c => c.chunkType === 'pdf_text' || c.chunkType === 'pdf_table')
  if (pdf.length) {
    const groups = new Map<string, ChunkRow[]>()
    for (const c of pdf) {
      const key = c.parentAttachmentId ?? '(unknown)'
      ;(groups.get(key) ?? groups.set(key, []).get(key)!).push(c)
    }
    for (const [attId, list] of groups) {
      const name = attachmentNames.get(attId) ?? 'attachment'
      parts.push(`\n=== ATTACHMENT: ${name} ===`)
      for (const c of list) {
        const label = [
          c.pageNumber != null ? `page ${c.pageNumber}` : null,
          c.chunkType === 'pdf_table' ? 'table' : null,
          c.sectionHeading,
        ].filter(Boolean).join(' · ')
        parts.push(label ? `[${label}]\n${c.content}` : c.content)
      }
    }
  }

  // Inline image captions
  const images = byType('inline_image')
  if (images.length) {
    parts.push('\n=== INLINE IMAGES (vision captions) ===')
    for (const c of images) {
      const label = c.sectionHeading ? `[${c.sectionHeading}]` : ''
      parts.push(`${label}${label ? '\n' : ''}${c.content}`)
    }
  }

  let text = parts.join('\n')
  let truncated = false
  if (text.length > MAX_CONTEXT_CHARS) {
    text = text.slice(0, MAX_CONTEXT_CHARS) + `\n\n[... truncated ${text.length - MAX_CONTEXT_CHARS} chars]`
    truncated = true
  }
  return { text, truncated }
}

export interface RunExtractionResult {
  /** mapItem'd rows, with invalid-category and NOISE rows already dropped. */
  rows:         OppRowData[]
  /** Count of raw items Sonnet returned, before the validity/NOISE filter. */
  rawItemCount: number
  usage:        SonnetUsage | null
  costUsd:      number | null
  durationMs:   number
  /** Non-null when the extraction should be treated as a skip. */
  error:        string | null
}

// Pure extraction step: given an already-assembled context string and the target
// category spec, run Sonnet in forced tool_use mode and map + filter its output
// into OppRowData rows. Writes NOTHING (no DB, no enrichment, no embedding) — the
// caller owns persistence. Exposed so the fixture harness (Brief 6.0) can exercise
// the exact same extraction path extractEmailV2 uses in production.
export async function runExtraction(
  spec: ExtractionSpec,
  context: string,
  ctx: MapCtx,
): Promise<RunExtractionResult> {
  const userMessage = `Extract all relevant records from this email. The content below is assembled from the email body, any linked pages, attachment text/tables, and inline-image vision captions.\n\n${context}`

  const t0 = Date.now()
  const result = await extractWithSonnet({
    systemPrompt:    spec.systemPrompt,
    userMessage,
    toolName:        spec.toolName,
    toolDescription: spec.toolDescription,
    inputSchema:     spec.inputSchema,
    zodSchema:       spec.responseSchema,
  })
  const durationMs = Date.now() - t0

  const usage = result.usage
  const costUsd = usage
    ? usage.inputTokens * PRICE.input + usage.outputTokens * PRICE.output +
      usage.cacheReadTokens * PRICE.cacheRead + usage.cacheCreationTokens * PRICE.cacheCreation
    : null

  if (result.error || !result.data) {
    return { rows: [], rawItemCount: 0, usage, costUsd, durationMs, error: result.error ?? 'no data' }
  }

  const items = (result.data as Record<string, unknown[]>)[spec.arrayKey] ?? []
  if (!Array.isArray(items) || items.length === 0) {
    return { rows: [], rawItemCount: 0, usage, costUsd, durationMs, error: null }
  }

  const rows = items
    .map((item): OppRowData => spec.mapItem(item, ctx))
    .filter(row => {
      if (!VALID_CATEGORY.has(row.category)) {
        console.error(`[extractV2] dropping item with invalid category "${row.category}"`)
        return false
      }
      if (row.category === 'NOISE') return false
      return true
    })

  return { rows, rawItemCount: items.length, usage, costUsd, durationMs, error: null }
}

export async function extractEmailV2(
  rawEmailId: string,
  organizationId: string,
): Promise<ExtractedOpportunity[]> {
  const email = await prisma.rawEmail.findUnique({
    where:  { id: rawEmailId },
    select: {
      id: true, subject: true, senderName: true, senderEmail: true,
      receivedDateTime: true, classifierCategory: true,
    },
  })
  if (!email) {
    console.error(`[extractV2] ${rawEmailId}: RawEmail not found`)
    return []
  }

  const category = email.classifierCategory ?? ''
  const spec = VALID_CATEGORY.has(category)
    ? EXTRACTION_SPEC_BY_CATEGORY[category as Category]
    : null
  if (!spec) {
    // NOISE, unclassified, or a category with no extractor — nothing to do.
    console.log(`[extractV2] ${rawEmailId}: no extraction spec for category "${category}" — skipping`)
    return []
  }

  // Read V2 chunks. Caller is responsible for having run V2 ingestion first.
  const chunks = await prisma.documentChunk.findMany({
    where:   { organizationId, parentEmailId: rawEmailId },
    orderBy: [{ chunkType: 'asc' }, { pageNumber: 'asc' }, { createdAt: 'asc' }],
    select: {
      chunkType: true, content: true, pageNumber: true, sectionHeading: true,
      hasTable: true, parentAttachmentId: true, parentLinkedResourceId: true,
    },
  })
  if (chunks.length === 0) {
    console.log(`[extractV2] ${rawEmailId}: 0 chunks — run V2 ingestion first; skipping`)
    return []
  }

  // Labels for linked pages / attachments.
  const [linkedResources, attachments] = await Promise.all([
    prisma.linkedResource.findMany({ where: { organizationId, parentEmailId: rawEmailId }, select: { id: true, url: true } }),
    prisma.attachment.findMany({ where: { organizationId, rawEmailId }, select: { id: true, name: true } }),
  ])
  const linkedUrls = new Map(linkedResources.map(r => [r.id, r.url]))
  const attachmentNames = new Map(attachments.map(a => [a.id, a.name]))

  const { text: context, truncated } = buildContext(email, chunks, attachmentNames, linkedUrls)
  if (truncated) console.log(`[extractV2] ${rawEmailId}: context truncated to ${MAX_CONTEXT_CHARS} chars`)

  const ctx: MapCtx = { subject: email.subject, senderName: email.senderName, senderEmail: email.senderEmail }
  const ext = await runExtraction(spec, context, ctx)
  const durationMs = ext.durationMs

  // Cost log (non-fatal). Lives in AIExtractionLog like the V1 cost logger.
  await prisma.aIExtractionLog.create({
    data: {
      organizationId, rawEmailId, model: 'claude-sonnet-4-6',
      extractorType: spec.kind, extractorVersion: '2.0', promptVersion: '2.0', schemaVersion: '2.0',
      inputTokens: ext.usage?.inputTokens ?? null, outputTokens: ext.usage?.outputTokens ?? null,
      estimatedCostUsd: ext.costUsd, durationMs, error: ext.error,
    },
  }).catch(() => {})

  if (ext.error) {
    console.error(`[extractV2] ${rawEmailId}: extraction skipped — ${ext.error}`)
    return []
  }

  if (ext.rawItemCount === 0) {
    console.log(`[extractV2] ${rawEmailId}: 0 records extracted — skipping (non-destructive)`)
    return []
  }

  const insertData = ext.rows
    .map(row => ({
      organizationId,
      rawEmailId,
      category:             row.category as Category,
      transactionType:      (VALID_TX.has(row.transactionType) ? row.transactionType : 'UNKNOWN') as TransactionType,
      propertyType:         row.propertyType,
      address:              row.address,
      neighborhood:         row.neighborhood,
      borough:              row.borough,
      city:                 row.city,
      state:                row.state,
      zip:                  row.zip,
      price:                row.price,
      minPrice:             row.minPrice,
      maxPrice:             row.maxPrice,
      beds:                 row.beds,
      baths:                row.baths,
      units:                row.units,
      squareFeet:           row.squareFeet,
      availabilityDate:     row.availabilityDate,
      sourceAgentName:      row.sourceAgentName,
      sourceAgentEmail:     row.sourceAgentEmail,
      sourceBrokerage:      row.sourceBrokerage,
      clientSide:           row.clientSide,
      status:               row.status,
      provenance:           row.provenance ?? null,
      extractedTitle:       row.extractedTitle,
      extractedSummary:     row.extractedSummary,
      classificationReason: row.classificationReason,
      confidenceScore:      row.confidenceScore,
      processingStatus:     'active',
      // Phase 4.0.7 — demand-side criteria folded onto the opportunity row
      // (deprecated CriteriaProfile). Listing categories use the column defaults.
      neighborhoods:        row.neighborhoods ?? [],
      propertyTypes:        row.propertyTypes ?? [],
      minBeds:              row.minBeds ?? null,
      maxBeds:              row.maxBeds ?? null,
      mustHaves:            row.mustHaves ?? null,
      dealbreakers:         row.dealbreakers ?? null,
      timeline:             row.timeline ?? null,
      criteriaActive:       row.criteriaActive ?? true,
    }))

  if (insertData.length === 0) {
    console.log(`[extractV2] ${rawEmailId}: all extracted records dropped as invalid — skipping`)
    return []
  }

  // Wipe-and-insert in a single transaction, only now that we have valid rows.
  const created = await prisma.$transaction(async (tx) => {
    const prior = await tx.extractedOpportunity.findMany({
      where:  { organizationId, rawEmailId },
      select: { id: true },
    })
    const priorIds = prior.map(p => p.id)

    await tx.reviewQueueItem.deleteMany({
      where: {
        organizationId,
        OR: [
          { rawEmailId },
          ...(priorIds.length ? [{ opportunityId: { in: priorIds } }] : []),
        ],
      },
    })
    // Brief 48 (PR 15): the old listings' matches go too. Nothing cascades: Brief 32
    // dropped the Match → listing foreign key (lib/extraction/listingMatches.ts), and
    // the comment here used to say they cascade-deleted [engineering precaution].
    if (priorIds.length) await tx.match.deleteMany({ where: matchesOfListings(priorIds) })
    await tx.extractedOpportunity.deleteMany({ where: { organizationId, rawEmailId } })

    const rows: ExtractedOpportunity[] = []
    for (const data of insertData) {
      rows.push(await tx.extractedOpportunity.create({ data }))
    }
    return rows
  })

  // Phase 4.6 — post-commit: enrich propertyType with NYC public data
  // (GeoSearch → PLUTO → optional ACRIS). Runs BEFORE the embedding loop so the
  // vector text reflects the corrected type. Non-fatal and per-row: a thrown
  // error leaves the committed row with the LLM's original propertyType. The
  // in-memory `opp` is mutated so buildOpportunityText() below sees the new type.
  const { resolvePropertyType } = await import('../enrichment/nyc')
  let enriched = 0
  for (const opp of created) {
    try {
      const result = await resolvePropertyType(opp)
      await prisma.extractedOpportunity.update({
        where: { id: opp.id },
        data: {
          propertyType:       result.propertyType,
          propertyTypeReason: result.propertyTypeReason,
        },
      })
      ;(opp as { propertyType: string | null }).propertyType = result.propertyType
      ;(opp as { propertyTypeReason: string | null }).propertyTypeReason = result.propertyTypeReason
      enriched++
    } catch (e) {
      console.error(`[extractV2] ${rawEmailId}: enrichment ${opp.id} failed: ${(e as Error).message}`)
    }
  }

  // Phase 4.0.5 — post-commit: embed every opportunity so it joins the match
  // pool. Reuses V1's helper; non-fatal — a failure leaves the committed row
  // intact. (CriteriaProfile writes were removed in Phase 4.0.7; the criteria
  // now live on the opportunity row's own columns.)
  let embedded = 0
  for (const opp of created) {
    try {
      await upsertOpportunityEmbedding(opp.id, buildOpportunityText(opp))
      embedded++
    } catch (e) {
      console.error(`[extractV2] ${rawEmailId}: embedding ${opp.id} failed: ${(e as Error).message}`)
    }
  }

  const costStr = ext.costUsd != null ? `$${ext.costUsd.toFixed(4)}` : 'n/a'
  console.log(
    `[extractV2] ${rawEmailId}: ${created.length} opportunit${created.length === 1 ? 'y' : 'ies'} ` +
    `(${spec.kind}) in ${durationMs}ms, cost ${costStr}; enriched ${enriched}/${created.length}; embedded ${embedded}/${created.length}`,
  )
  return created
}

// Brief 6.3 Fix #1B — lead-recovery second pass, persistence side.
//
// Called from ingestEmailV2 when the classifier routed an email to an
// informational bucket (CLIENT_CONVERSATION / NOISE / MARKET_REPORT). Runs the
// conservative recoverBuriedLead() scan over the same assembled context the
// extractor would see, and — only if a concrete lead is found — persists ONE
// additional ExtractedOpportunity tagged with provenance:
//   - 'comp_reference'  when the recovered item is a historical/sold comp
//     (kept OUT of match pools by matchmaking/searchParties)
//   - 'buried_recovery' for a genuine buried lead (enters the pool normally)
//
// Idempotent: prior recovered rows for this email are wiped first. Returns the
// created row or null. Non-fatal by contract — callers wrap it in try/catch.
export async function recoverAndPersistBuriedLead(
  rawEmailId: string,
  organizationId: string,
): Promise<ExtractedOpportunity | null> {
  const email = await prisma.rawEmail.findUnique({
    where:  { id: rawEmailId },
    select: { id: true, subject: true, senderName: true, senderEmail: true, receivedDateTime: true },
  })
  if (!email) return null

  const chunks = await prisma.documentChunk.findMany({
    where:   { organizationId, parentEmailId: rawEmailId },
    orderBy: [{ chunkType: 'asc' }, { pageNumber: 'asc' }, { createdAt: 'asc' }],
    select: {
      chunkType: true, content: true, pageNumber: true, sectionHeading: true,
      hasTable: true, parentAttachmentId: true, parentLinkedResourceId: true,
    },
  })
  if (chunks.length === 0) return null

  const [linkedResources, attachments] = await Promise.all([
    prisma.linkedResource.findMany({ where: { organizationId, parentEmailId: rawEmailId }, select: { id: true, url: true } }),
    prisma.attachment.findMany({ where: { organizationId, rawEmailId }, select: { id: true, name: true } }),
  ])
  const linkedUrls = new Map(linkedResources.map(r => [r.id, r.url]))
  const attachmentNames = new Map(attachments.map(a => [a.id, a.name]))

  const { text: context } = buildContext(email, chunks, attachmentNames, linkedUrls)
  const ctx: MapCtx = { subject: email.subject, senderName: email.senderName, senderEmail: email.senderEmail }

  const { recoverBuriedLead } = await import('./recoverBuriedLead')
  const lead = await recoverBuriedLead(context, ctx)
  if (!lead) return null

  const provenance = lead.isHistoricalComp ? 'comp_reference' : 'buried_recovery'
  const transactionType: TransactionType =
    (lead.category === 'RENTER_INQUIRY' || lead.category === 'LANDLORD_LEAD') ? 'RENTAL' : 'SALE'

  // Idempotency: replace any prior recovered rows for this email. Brief 48 (PR 15):
  // with their matches, in one transaction (nothing cascades; lib/extraction/listingMatches.ts)
  // [engineering precaution]. Non-fatal, as before.
  try {
    await prisma.$transaction(tx => deleteListingsAndMatches(tx, {
      organizationId, rawEmailId, provenance: { in: ['buried_recovery', 'comp_reference'] },
    }))
  } catch (e) {
    console.error(`[extractV2] ${rawEmailId}: clearing the old recovered rows failed: ${(e as Error).message}`)
  }

  // A recovered lead keeps its own words, estate, probate or divorce details
  // included. Ryan's decision, 2026-10-17: saved seller notes may keep these
  // details. Buyer-facing text still never names motivation (engineering
  // precaution, Brief 41 H7).
  const created = await prisma.extractedOpportunity.create({
    data: {
      organizationId, rawEmailId,
      category:             lead.category as Category,
      transactionType,
      address:              lead.address,
      neighborhood:         lead.neighborhood,
      borough:              lead.borough,
      price:                lead.price,
      beds:                 lead.beds,
      clientSide:           lead.clientSide,
      provenance,
      extractedTitle:       lead.summary || `Recovered ${lead.category}`,
      extractedSummary:     lead.summary,
      classificationReason: `[lead-recovery second pass] ${lead.reason}`,
      confidenceScore:      lead.confidence,
      processingStatus:     'active',
    },
  })
  console.log(`[extractV2] ${rawEmailId}: recovered buried ${lead.category} (provenance=${provenance}, conf ${lead.confidence})`)
  return created
}
