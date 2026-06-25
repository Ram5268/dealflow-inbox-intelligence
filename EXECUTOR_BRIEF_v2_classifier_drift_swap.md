# Executor Brief: Fix V2 Classifier + Swap Drift to Sonnet + Catch Up Last 3 Days

## Context (for fresh session)

DealFlow Inbox Intelligence is a single-tenant read-only Outlook inbox intelligence app for Ryan Martin (Douglas Elliman, NYC). `INGEST_V2=true` was set 2026-06-04 21:07 EDT, which gated off the V1 ingest path — but the source classifier lived inside V1. Result: every RawEmail since the gate has `classifierCategory = NULL`, `extractEmailV2` silently no-ops at `lib/extraction/extractEmailV2.ts:141-149`, and zero V2 `ExtractedOpportunity` rows have been produced for ~500 emails over 3 days. Goal: (1) lift the classifier into the V2 orchestrator so new emails get classified; (2) swap Drift chat from `gpt-4o` to `claude-sonnet-4-6` with `tool_use` for strict JSON; (3) build a one-shot catch-up script for the silently-dropped emails. NO V1 backfill.

## Pre-flight (read these files first)

- `/Users/Ram5268/Library/Mobile Documents/com~apple~CloudDocs/Antigravity Projects/dealflow-inbox-intelligence/lib/ingestion/ingestEmailV2.ts` (V2 orchestrator — main edit site)
- `/Users/Ram5268/Library/Mobile Documents/com~apple~CloudDocs/Antigravity Projects/dealflow-inbox-intelligence/lib/ingestion/sourceClassifier.ts` (classifier function being lifted)
- `/Users/Ram5268/Library/Mobile Documents/com~apple~CloudDocs/Antigravity Projects/dealflow-inbox-intelligence/lib/ingestion/costLogger.ts` (logClassifier helper)
- `/Users/Ram5268/Library/Mobile Documents/com~apple~CloudDocs/Antigravity Projects/dealflow-inbox-intelligence/lib/ingestion/types.ts` (PROMPT_VERSION, ClassifierInput)
- `/Users/Ram5268/Library/Mobile Documents/com~apple~CloudDocs/Antigravity Projects/dealflow-inbox-intelligence/lib/extraction/extractEmailV2.ts` (silent no-op happens at line 141-149)
- `/Users/Ram5268/Library/Mobile Documents/com~apple~CloudDocs/Antigravity Projects/dealflow-inbox-intelligence/lib/extraction/sonnetExtractor.ts` (proven tool_use + cache_control pattern to mirror)
- `/Users/Ram5268/Library/Mobile Documents/com~apple~CloudDocs/Antigravity Projects/dealflow-inbox-intelligence/app/api/chat/route.ts` (Drift swap target)
- `/Users/Ram5268/Library/Mobile Documents/com~apple~CloudDocs/Antigravity Projects/dealflow-inbox-intelligence/scripts/reprocess-v2-extraction.ts` (cohort-build + cost-guard pattern to mirror in catch-up)
- `/Users/Ram5268/Library/Mobile Documents/com~apple~CloudDocs/Antigravity Projects/dealflow-inbox-intelligence/lib/matchmaking.ts` (`runMatchmaking(newOppIds: string[])` signature at line 78)
- `/Users/Ram5268/Library/Mobile Documents/com~apple~CloudDocs/Antigravity Projects/dealflow-inbox-intelligence/prisma/schema.prisma` (Category enum lines 11-32; RawEmail line 160; ExtractedOpportunity line 227)

## Task 1: Wire classifier into V2 pipeline

**File to edit:** `/Users/Ram5268/Library/Mobile Documents/com~apple~CloudDocs/Antigravity Projects/dealflow-inbox-intelligence/lib/ingestion/ingestEmailV2.ts`

### Edit 1a — add classifier-related imports (line 23 area)

Replace:
```ts
import { extractEmailV2 } from '../extraction/extractEmailV2'
```

With:
```ts
import { extractEmailV2 } from '../extraction/extractEmailV2'
import { sourceClassifier, buildIdempotencyKey } from './sourceClassifier'
import { logClassifier } from './costLogger'
import { PROMPT_VERSION } from './types'
```

### Edit 1b — add `classifierCategory` to the RawEmail select (lines 57-65)

Replace:
```ts
  const email = await prisma.rawEmail.findUnique({
    where:  { id: emailId },
    select: {
      id: true, subject: true, senderName: true, senderEmail: true,
      receivedDateTime: true, bodyContent: true, bodyPreview: true,
      bodyContentType: true, rawJson: true, graphMessageId: true,
      threadId: true,
    },
  })
  if (!email) throw new Error(`RawEmail ${emailId} not found`)
```

With:
```ts
  const email = await prisma.rawEmail.findUnique({
    where:  { id: emailId },
    select: {
      id: true, subject: true, senderName: true, senderEmail: true,
      receivedDateTime: true, bodyContent: true, bodyPreview: true,
      bodyContentType: true, rawJson: true, graphMessageId: true,
      threadId: true, classifierCategory: true,
    },
  })
  if (!email) throw new Error(`RawEmail ${emailId} not found`)
```

### Edit 1c — insert classifier call AFTER chunking, BEFORE `extractEmailV2` (lines 274-282)

Replace the existing Step 7 block:
```ts
  // 7. Phase 4.0 — V2 extraction. Reads the chunks just persisted and writes
  // clean ExtractedOpportunity rows (Sonnet tool_use). Idempotent + non-fatal:
  // a failure here must not undo the chunking/embedding work above.
  try {
    const opps = await extractEmailV2(emailId, organizationId)
    console.log(`[ingestV2] ${emailId}: extracted ${opps.length} opportunities`)
  } catch (e) {
    errors.push(`extractEmailV2: ${(e as Error).message}`)
  }
```

With:
```ts
  // 6b. Classifier (lifted from V1 in 2026-06-07 fix). When INGEST_V2=true
  // gated off V1, the classifier stopped running and extractEmailV2 silently
  // no-op'd because classifierCategory was null. We re-run it here, AFTER
  // chunking so a classifier failure cannot undo embedding work. Guarded by
  // `!email.classifierCategory` so re-runs are idempotent and pre-existing
  // tags (e.g. legacy HOTSHEET sentinel, V1 classifications) are preserved.
  let classifierCategory: string | null = email.classifierCategory ?? null
  let needsDeepExtract = true
  if (!email.classifierCategory) {
    try {
      const atts = await prisma.attachment.findMany({
        where: { organizationId, rawEmailId: emailId },
        select: { name: true, mimeType: true },
      })
      const classifierKey = buildIdempotencyKey(emailId, 'source_classifier', PROMPT_VERSION)
      const classifyStart = Date.now()
      const classified = await sourceClassifier({
        rawEmailId:          emailId,
        subject:             email.subject,
        senderName:          email.senderName,
        senderEmail:         email.senderEmail,
        bodyPreview:         email.bodyPreview,
        bodyFirst500:        bodyText ? bodyText.slice(0, 500) : null,
        attachmentNames:     atts.map(a => a.name),
        attachmentMimeTypes: atts.map(a => a.mimeType),
        attachmentCount:     atts.length,
      })
      classifierCategory = classified.category
      needsDeepExtract   = classified.needsDeepExtract
      await logClassifier(emailId, classifierKey, classified, Date.now() - classifyStart).catch(() => {})
      await prisma.rawEmail.update({
        where: { id: emailId },
        data: {
          classifierStatus:     'classified',
          classifierCategory:   classified.category,
          classifierConfidence: classified.confidence,
          extractionStatus:     classified.needsDeepExtract ? 'pending' : 'skipped',
          lastProcessedAt:      new Date(),
          idempotencyKey:       classifierKey,
        },
      }).catch(() => {})
      console.log(`[ingestV2] ${emailId}: classified as ${classified.category} (conf ${classified.confidence})`)
    } catch (e) {
      errors.push(`classifier: ${(e as Error).message}`)
    }
  }

  // 7. Phase 4.0 — V2 extraction. Reads the chunks just persisted and writes
  // clean ExtractedOpportunity rows (Sonnet tool_use). Idempotent + non-fatal:
  // a failure here must not undo the chunking/embedding work above.
  if (needsDeepExtract && classifierCategory) {
    try {
      const opps = await extractEmailV2(emailId, organizationId)
      console.log(`[ingestV2] ${emailId}: extracted ${opps.length} opportunities (${classifierCategory})`)
    } catch (e) {
      errors.push(`extractEmailV2: ${(e as Error).message}`)
    }
  } else {
    console.log(`[ingestV2] ${emailId}: classifier=${classifierCategory ?? 'null'} needsDeepExtract=${needsDeepExtract} — skipping extraction`)
  }
```

**Why:** Classifier is gated off when `INGEST_V2=true`. Inserting it AFTER chunking (not before) preserves the invariant that V2 chunks land deterministically even on classifier failure — chunks power retrieval and are useful even for NOISE. The `if (!email.classifierCategory)` guard makes the entire V2 orchestrator idempotent for re-runs, preserves any pre-existing HOTSHEET sentinel, and avoids overwriting V1 classifications. `bodyText` (line 83) is already in scope. `processed: true` is NOT added here — `backgroundSync.ts:306` already sets it on every RawEmail in the V2 path.

**Verify:**
```bash
cd "/Users/Ram5268/Library/Mobile Documents/com~apple~CloudDocs/Antigravity Projects/dealflow-inbox-intelligence"
npx prisma generate && npx tsc --noEmit
```
Then trigger one sync from the app's `/dashboard` Check In button and run:
```bash
npx tsx -e "import { prisma } from './lib/prisma'; (async () => { const r = await prisma.rawEmail.findMany({ where: { receivedDateTime: { gte: new Date(Date.now() - 1000*60*60) } }, select: { id: true, classifierCategory: true, subject: true }, orderBy: { receivedDateTime: 'desc' }, take: 10 }); console.table(r); await prisma.\$disconnect() })()"
```
Expect: recent rows show non-null `classifierCategory`.

## Task 2: Swap Drift chat from gpt-4o to Claude Sonnet 4.6

**File to edit:** `/Users/Ram5268/Library/Mobile Documents/com~apple~CloudDocs/Antigravity Projects/dealflow-inbox-intelligence/app/api/chat/route.ts`

**Approach:** Use Sonnet `tool_use` forcing (mirrors the proven `lib/extraction/sonnetExtractor.ts:109-130` pattern), with `cache_control: ephemeral` on the static `SYSTEM_PROMPT` block. `tool_use` is preferred over prompt-engineered JSON because it gives parsed-object output (no markdown-fence parse ladder), it's the established Phase 4 convention, and the cross-check identified prompt-engineered fallback as fragile. The existing 3-tier text-parse fallback at lines 247-265 is preserved as graceful degrade for the rare case Sonnet skips the tool. `pendingEvent` is declared as a plain `type: 'object'` (NOT a `['object','null']` union — Anthropic SDK ^0.95.1 TypeScript types reject type-arrays); it's simply omitted from the root `required` list so Sonnet can leave it out. Downstream `aiResult.pendingEvent ?? null` (line 301) treats omission as null.

### Edit 2a — add Anthropic import (line 9)

Replace:
```ts
import OpenAI from 'openai'
```

With:
```ts
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
```

### Edit 2b — replace OpenAI gpt-4o call block (lines 200-265)

Replace:
```ts
    // ── Process files into text chunks and image parts ────────────────────────
    type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail: 'high' } }
    const imageParts: Part[] = []
    let textContent = userMessage || '(Please analyze the attached file.)'

    for (const file of files) {
      if (file.type === 'image') {
        imageParts.push({
          type: 'image_url',
          image_url: { url: `data:${file.mimeType};base64,${file.content}`, detail: 'high' },
        })
      } else if (file.type === 'text') {
        textContent += `\n\n--- File: ${file.name} ---\n${file.content.slice(0, 15000)}\n---`
      } else if (file.type === 'binary') {
        const buffer = Buffer.from(file.content, 'base64')
        const extracted = await parseBinary(buffer, file.name, file.mimeType)
        textContent += `\n\n--- File: ${file.name} ---\n${extracted.slice(0, 15000)}\n---`
      }
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const hasImages = imageParts.length > 0
    const userContent: Part[] | string = hasImages
      ? [{ type: 'text', text: textContent }, ...imageParts]
      : textContent

    // ── Final system prompt ──────────────────────────────────────────────────
    // PRE blocks (mortgage, acris, dob, calendar, matches, liveStreetEasy)
    // + retrievalResult.context (top-15 [DEAL:id] lines from contextBuilder)
    // + attachmentsContext (per-rawEmailId PDF/doc text)
    // + POST blocks (mojo — positioned after retrieval so its BUYER_ISO match flag reads against the cited deals)
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: `${SYSTEM_PROMPT}${composed.pre}\n\n${retrievalResult.context}${attachmentsContext}${composed.post}` },
      ...conversationHistory.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content: userContent },
    ]

    const firstCompletion = await client.chat.completions.create({
      model: 'gpt-4o',
      messages,
      temperature: 0.3,
      max_tokens: 4000,
    })

    const raw = (firstCompletion.choices[0].message.content ?? '').trim()
    console.log('[DealFlow] Raw AI response:', raw.slice(0, 200))

    // Parse JSON robustly
    let aiResult: { response: string; suggestions: string[]; pendingEvent?: Record<string, string> | null; referencedDeals?: string[] }
    try {
      aiResult = JSON.parse(raw)
    } catch {
      // Strip markdown fences if present
      const stripped = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/m, '').trim()
      try {
        aiResult = JSON.parse(stripped)
      } catch {
        // Extract JSON object from anywhere in the string
        const match = stripped.match(/\{[\s\S]*\}/)
        try {
          aiResult = match ? JSON.parse(match[0]) : { response: raw, suggestions: [] }
        } catch {
          aiResult = { response: raw, suggestions: [] }
        }
      }
    }
```

With:
```ts
    // ── Process files into text + Anthropic image blocks ────────────────────
    // Anthropic image source is raw base64 (NOT a data: URL) and requires
    // media_type ∈ {image/jpeg, image/png, image/gif, image/webp}.
    type AImagePart = {
      type: 'image'
      source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string }
    }
    type ATextPart = { type: 'text'; text: string }
    type AUserPart = ATextPart | AImagePart

    const imageParts: AImagePart[] = []
    let textContent = userMessage || '(Please analyze the attached file.)'

    for (const file of files) {
      if (file.type === 'image') {
        const mt = file.mimeType as AImagePart['source']['media_type']
        const media_type: AImagePart['source']['media_type'] =
          mt === 'image/jpeg' || mt === 'image/png' || mt === 'image/gif' || mt === 'image/webp' ? mt : 'image/png'
        imageParts.push({
          type: 'image',
          source: { type: 'base64', media_type, data: file.content },
        })
      } else if (file.type === 'text') {
        textContent += `\n\n--- File: ${file.name} ---\n${file.content.slice(0, 15000)}\n---`
      } else if (file.type === 'binary') {
        const buffer = Buffer.from(file.content, 'base64')
        const extracted = await parseBinary(buffer, file.name, file.mimeType)
        textContent += `\n\n--- File: ${file.name} ---\n${extracted.slice(0, 15000)}\n---`
      }
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const userBlocks: AUserPart[] = [{ type: 'text', text: textContent }, ...imageParts]

    // ── System prompt: static SYSTEM_PROMPT cached; dynamic per-turn block uncached ──
    const dynamicSystemBlock = `${composed.pre}\n\n${retrievalResult.context}${attachmentsContext}${composed.post}`
    const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: dynamicSystemBlock },
    ]

    // ── Tool definition for strict JSON output ──
    const RESPONSE_TOOL_NAME = 'drift_response'
    const responseTool: Anthropic.Messages.Tool = {
      name: RESPONSE_TOOL_NAME,
      description: "Return Drift's reply to Ryan as structured JSON. Always call this tool exactly once per turn.",
      input_schema: {
        type: 'object',
        properties: {
          response: {
            type: 'string',
            description: 'Plain text response. No markdown, no bold, no italics, no bullet dashes. One line per listing per the rules.',
          },
          suggestions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Exactly 2 specific follow-up questions.',
          },
          pendingEvent: {
            type: 'object',
            description: "Calendar event proposal awaiting Ryan's confirm. Omit entirely on non-calendar turns.",
            properties: {
              subject:  { type: 'string' },
              startISO: { type: 'string', description: 'ISO 8601 datetime' },
              endISO:   { type: 'string', description: 'Optional ISO 8601 datetime; defaults to startISO + 30min' },
              location: { type: 'string' },
              notes:    { type: 'string' },
            },
            required: ['subject', 'startISO'],
          },
          referencedDeals: {
            type: 'array',
            items: { type: 'string' },
            description: 'Exact deal IDs from [DEAL:id] tags discussed in the response. Traceability only — does not gate cards.',
          },
        },
        required: ['response', 'suggestions', 'referencedDeals'],
      } as Anthropic.Messages.Tool.InputSchema,
    }

    const anthropicHistory: Anthropic.Messages.MessageParam[] = conversationHistory.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }))

    const firstCompletion = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      temperature: 0.3,
      system: systemBlocks,
      messages: [
        ...anthropicHistory,
        { role: 'user', content: userBlocks },
      ],
      tools: [responseTool],
      tool_choice: { type: 'tool', name: RESPONSE_TOOL_NAME },
    })

    // ── Extract tool_use.input (already parsed by SDK) ──
    type AiResult = { response: string; suggestions: string[]; pendingEvent?: Record<string, string> | null; referencedDeals?: string[] }
    let aiResult: AiResult
    const toolUseBlock = firstCompletion.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use' && b.name === RESPONSE_TOOL_NAME,
    )
    if (toolUseBlock) {
      aiResult = toolUseBlock.input as AiResult
      console.log('[DealFlow] Sonnet tool_use input keys:', Object.keys(aiResult).join(','))
    } else {
      // Graceful degrade: Sonnet skipped the tool. Parse a text block the old way.
      const textBlock = firstCompletion.content.find((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      const raw = (textBlock?.text ?? '').trim()
      console.warn('[DealFlow] Sonnet returned no tool_use; falling back to text parse. Raw:', raw.slice(0, 200))
      try {
        aiResult = JSON.parse(raw)
      } catch {
        const stripped = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/m, '').trim()
        try {
          aiResult = JSON.parse(stripped)
        } catch {
          const match = stripped.match(/\{[\s\S]*\}/)
          try {
            aiResult = match ? JSON.parse(match[0]) : { response: raw || 'Sorry, I had trouble formatting that. Try rephrasing?', suggestions: [], referencedDeals: [] }
          } catch {
            aiResult = { response: raw || 'Sorry, I had trouble formatting that. Try rephrasing?', suggestions: [], referencedDeals: [] }
          }
        }
      }
    }
```

### Edit 2c — instantiate a local OpenAI client for the session-title call (lines 319-321)

The original `const client = new OpenAI(...)` at line 220 is being removed. The title path at line 321 still needs an OpenAI client.

Replace:
```ts
    if (!session.title && history.length === 0) {
      try {
        const titleCompletion = await client.chat.completions.create({
          model: 'gpt-4o-mini',
```

With:
```ts
    if (!session.title && history.length === 0) {
      try {
        const openaiForTitle = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
        const titleCompletion = await openaiForTitle.chat.completions.create({
          model: 'gpt-4o-mini',
```

**Preserve:** the cleanup regex at lines 267-270 (strip `**bold**`, `*italic*`, `[DEAL:tag]`), `scoreMap` at line 285, `pendingEvent` storage at line 301-304, message persistence at lines 307-316, and the entire calendar-confirm fast-path block earlier in the file. JSON output shape stays `{ response, suggestions, pendingEvent, referencedDeals }`.

**Do NOT change:** the session-title call still uses `gpt-4o-mini` (line 322); `parseSearchQuery` in `lib/ai.ts` is untouched.

**Verify:**
```bash
cd "/Users/Ram5268/Library/Mobile Documents/com~apple~CloudDocs/Antigravity Projects/dealflow-inbox-intelligence"
npx tsc --noEmit
npm run dev
```
Open `http://localhost:3000/chat`, send "Show me Brooklyn rentals under $5k", confirm a coherent reply and 2 follow-up suggestions render. Tail logs and confirm a line like `[DealFlow] Sonnet tool_use input keys: response,suggestions,referencedDeals`. If that line never appears and the fallback warning fires repeatedly, monitor the first ~10 turns — if compliance stays low, file a follow-up to swap to prompt-engineered JSON. Anthropic SDK is `^0.95.1` (verified).

## Task 3: Build catch-up script for last 3 days

**File to create:** `/Users/Ram5268/Library/Mobile Documents/com~apple~CloudDocs/Antigravity Projects/dealflow-inbox-intelligence/scripts/catchup-v2-extract.ts`

**What it does:** Builds cohort of `RawEmail` rows where `createdAt >= 2026-06-05T01:07:16Z` (gate landing, 2026-06-04 21:07 EDT) AND `opportunities { none: { processingStatus: 'active' } }`. For each row: (1) if `classifierCategory` is null, runs `sourceClassifier` and persists the result (skipping rows already tagged so HOTSHEET sentinel and any pre-existing V1 tags are preserved); (2) if `DocumentChunk.count > 0`, calls `extractEmailV2(emailId, organizationId)` directly (cheap, non-destructive); (3) if `DocumentChunk.count === 0`, calls `ingestEmailV2(emailId)` end-to-end (full pipeline — re-scrape/parse/embed). After the loop, runs `runMatchmaking` on the collected new opportunity IDs.

**Idempotency:** the per-row `classifierCategory` guard skips re-classification on re-runs; `extractEmailV2`'s wipe-and-insert inside a transaction is safe to re-run; `ingestEmailV2`'s `deleteExistingChunks` wipe at line 75 is destructive but only triggers on the chunk-less subcohort.

**Cost gate:** requires `--dry-run` or `--confirm` (refuses without one). Supports `--max-cost USD` (aggregates `AIExtractionLog.estimatedCostUsd` for `claude-sonnet-4-6` since run start; aborts queue when exceeded), `--limit N`, `--concurrency N` (default 5).

**Concurrency:** default 5, matches `scripts/reprocess-v2-extraction.ts:31`. Drop to 3 if you see 429s.

Create the file with exactly this content:

```ts
// scripts/catchup-v2-extract.ts
// One-shot catch-up: re-run classifier + V2 extraction on every RawEmail
// received since the INGEST_V2 gate landed (2026-06-04 21:07 EDT /
// 2026-06-05 01:07 UTC) that has no active ExtractedOpportunity row.
//
// Splits work by chunk presence:
//   - chunks exist → extractEmailV2 only (cheap, non-destructive)
//   - chunks absent → ingestEmailV2 end-to-end (full pipeline)
//
// Usage:
//   INGEST_V2=true npx tsx scripts/catchup-v2-extract.ts --dry-run
//   INGEST_V2=true npx tsx scripts/catchup-v2-extract.ts --confirm
//   INGEST_V2=true npx tsx scripts/catchup-v2-extract.ts --confirm --limit 10
//   INGEST_V2=true npx tsx scripts/catchup-v2-extract.ts --confirm --max-cost 25 --concurrency 5
import 'dotenv/config'
process.env.INGEST_V2 = 'true'
import PQueue from 'p-queue'
import { prisma } from '../lib/prisma'
import { getCurrentOrgId } from '../lib/auth/orgContext'
import { sourceClassifier } from '../lib/ingestion/sourceClassifier'
import { ingestEmailV2 } from '../lib/ingestion/ingestEmailV2'
import { extractEmailV2 } from '../lib/extraction/extractEmailV2'
import { runMatchmaking } from '../lib/matchmaking'

// Gate landed 2026-06-04 21:07 EDT (commit 3cccde1). UTC = 2026-06-05T01:07:16Z.
const GATE_TS = new Date('2026-06-05T01:07:16.000Z')

// ── Arg parsing ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const DRY_RUN     = argv.includes('--dry-run')
const CONFIRM     = argv.includes('--confirm')
const LIMIT       = flagValue('--limit')      ? parseInt(flagValue('--limit')!, 10)        : undefined
const MAX_COST    = flagValue('--max-cost')   ? parseFloat(flagValue('--max-cost')!)       : undefined
const CONCURRENCY = flagValue('--concurrency')? parseInt(flagValue('--concurrency')!, 10)  : 5

if (!DRY_RUN && !CONFIRM) {
  console.error('Refusing to run without --dry-run or --confirm. Pass one explicitly.')
  process.exit(1)
}

interface Candidate {
  id:                 string
  subject:            string
  senderName:         string | null
  senderEmail:        string | null
  bodyPreview:        string | null
  bodyContent:        string | null
  receivedDateTime:   Date
  classifierCategory: string | null
  chunkCount:         number
  attachmentNames:    string[]
  attachmentMimeTypes:string[]
}

async function buildCohort(organizationId: string): Promise<Candidate[]> {
  const rows = await prisma.rawEmail.findMany({
    where: {
      organizationId,
      createdAt:     { gte: GATE_TS },
      opportunities: { none: { processingStatus: 'active' } },
    },
    select: {
      id: true, subject: true, senderName: true, senderEmail: true,
      bodyPreview: true, bodyContent: true, receivedDateTime: true,
      classifierCategory: true,
      attachments: { select: { name: true, mimeType: true } },
    },
    orderBy: { createdAt: 'asc' },
    ...(LIMIT != null ? { take: LIMIT } : {}),
  })
  if (rows.length === 0) return []

  const ids = rows.map(r => r.id)
  const chunkCounts = await prisma.documentChunk.groupBy({
    by:     ['parentEmailId'],
    where:  { organizationId, parentEmailId: { in: ids } },
    _count: { _all: true },
  })
  const chunkMap = new Map(chunkCounts.map(c => [c.parentEmailId, c._count._all]))

  return rows.map(r => ({
    id:                  r.id,
    subject:             r.subject,
    senderName:          r.senderName,
    senderEmail:         r.senderEmail,
    bodyPreview:         r.bodyPreview,
    bodyContent:         r.bodyContent,
    receivedDateTime:    r.receivedDateTime,
    classifierCategory:  r.classifierCategory,
    chunkCount:          chunkMap.get(r.id) ?? 0,
    attachmentNames:     r.attachments.map(a => a.name).filter(Boolean) as string[],
    attachmentMimeTypes: r.attachments.map(a => a.mimeType).filter(Boolean) as string[],
  }))
}

async function classifyIfNeeded(c: Candidate): Promise<string | null> {
  if (c.classifierCategory) return c.classifierCategory
  const classified = await sourceClassifier({
    rawEmailId:          c.id,
    subject:             c.subject,
    senderName:          c.senderName,
    senderEmail:         c.senderEmail,
    bodyPreview:         c.bodyPreview,
    bodyFirst500:        c.bodyContent ? c.bodyContent.slice(0, 500) : null,
    attachmentNames:     c.attachmentNames,
    attachmentMimeTypes: c.attachmentMimeTypes,
    attachmentCount:     c.attachmentNames.length,
  })
  await prisma.rawEmail.update({
    where: { id: c.id },
    data: {
      classifierStatus:     'classified',
      classifierCategory:   classified.category,
      classifierConfidence: classified.confidence,
      extractionStatus:     classified.needsDeepExtract ? 'pending' : 'skipped',
      lastProcessedAt:      new Date(),
    },
  }).catch(() => {})
  return classified.category
}

async function main() {
  // Pre-flight env check.
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'QDRANT_URL', 'DATABASE_URL']) {
    if (!process.env[k]) { console.error(`Missing env: ${k}`); process.exit(1) }
  }

  const organizationId = await getCurrentOrgId()
  const runStart = new Date()

  console.log('═══════════════════════════════════════════════════════════════════')
  console.log('V2 catch-up: classifier + extraction for emails dropped since gate')
  console.log(`  gate:        ${GATE_TS.toISOString()}`)
  console.log(`  mode:        ${DRY_RUN ? 'DRY-RUN' : 'LIVE'}`)
  console.log(`  concurrency: ${CONCURRENCY}  limit: ${LIMIT ?? 'none'}  maxCost: ${MAX_COST ?? 'none'}`)
  console.log('═══════════════════════════════════════════════════════════════════')

  const cohort = await buildCohort(organizationId)
  console.log(`\nCohort: ${cohort.length} RawEmail rows since gate with no active opportunities.`)
  if (cohort.length === 0) { await prisma.$disconnect(); return }

  const withChunks    = cohort.filter(c => c.chunkCount > 0).length
  const withoutChunks = cohort.length - withChunks
  const needsClassify = cohort.filter(c => !c.classifierCategory).length
  const isHotsheet    = cohort.filter(c => c.classifierCategory === 'HOTSHEET').length

  console.log(`  with chunks       (extractEmailV2 only):  ${withChunks}`)
  console.log(`  without chunks    (ingestEmailV2 full):   ${withoutChunks}`)
  console.log(`  needs classifier  (classifierCategory NULL): ${needsClassify}`)
  console.log(`  HOTSHEET sentinel (will be skipped by extractor): ${isHotsheet}`)

  // Rough estimate: $0.025 per non-hotsheet email (Sonnet extract dominates).
  const projected = (cohort.length - isHotsheet) * 0.025
  console.log(`  projected Sonnet cost: ~$${projected.toFixed(2)}`)

  if (DRY_RUN) {
    console.log('\n  Sample (first 10):')
    for (const c of cohort.slice(0, 10)) {
      console.log(`    • ${c.id}  cat=${c.classifierCategory ?? 'NULL'}  chunks=${c.chunkCount}  ${c.subject.slice(0, 70)}`)
    }
    console.log('\n  DRY RUN — no work performed. Re-run with --confirm to execute.')
    await prisma.$disconnect()
    return
  }

  const queue = new PQueue({ concurrency: CONCURRENCY })
  const cohortIds = cohort.map(c => c.id)
  let processed = 0, ok = 0, skipped = 0, failed = 0
  let aborted = false
  const errors: string[] = []

  await queue.addAll(cohort.map(c => async () => {
    if (aborted) return
    const t0 = Date.now()
    try {
      const category = await classifyIfNeeded(c)

      if (category === 'HOTSHEET') {
        skipped++; processed++
        console.log(`  ⊘ ${c.id} [HOTSHEET] skipped (sentinel — no V2 extraction)`)
        return
      }

      if (c.chunkCount === 0) {
        await ingestEmailV2(c.id)
      } else {
        await extractEmailV2(c.id, organizationId)
      }

      const oppCount = await prisma.extractedOpportunity.count({
        where: { organizationId, rawEmailId: c.id, processingStatus: 'active' },
      })
      processed++
      if (oppCount > 0) {
        ok++
        console.log(`  ✓ ${c.id} [${category}] → ${oppCount} opp(s) in ${Date.now() - t0}ms`)
      } else {
        skipped++
        console.log(`  ∅ ${c.id} [${category}] → 0 opps (non-extractable category or empty result)`)
      }
    } catch (e) {
      processed++; failed++
      const msg = (e as Error).message
      errors.push(`${c.id}: ${msg}`)
      console.error(`  ✗ ${c.id} threw: ${msg}`)
    }

    if (MAX_COST != null) {
      try {
        const agg = await prisma.aIExtractionLog.aggregate({
          where: { organizationId, model: 'claude-sonnet-4-6', createdAt: { gte: runStart } },
          _sum:  { estimatedCostUsd: true },
        })
        const spent = agg._sum.estimatedCostUsd ?? 0
        if (spent > MAX_COST) {
          aborted = true
          queue.clear()
          console.error(`\n  ⛔ Cost guard tripped: $${spent.toFixed(4)} > $${MAX_COST}. Stopping.`)
        }
      } catch (e) {
        console.error(`  [cost-guard] skipped: ${(e as Error).message}`)
      }
    }

    if (processed % 25 === 0) {
      console.log(`  [progress] ${processed}/${cohort.length}  ok=${ok}  skipped=${skipped}  failed=${failed}`)
    }
  }))

  // Matchmaking on the new opportunities (mirrors lib/backgroundSync.ts:339).
  const newOpps = await prisma.extractedOpportunity.findMany({
    where:  { organizationId, rawEmailId: { in: cohortIds }, processingStatus: 'active' },
    select: { id: true },
  })
  const newOppIds = newOpps.map(o => o.id)
  let matchSummary = '0 matches'
  if (newOppIds.length > 0) {
    try {
      const m = await runMatchmaking(newOppIds)
      matchSummary = `${m.total} matches (${m.highConfidence} high-confidence)`
    } catch (e) {
      matchSummary = `runMatchmaking failed: ${(e as Error).message}`
    }
  }

  const costAgg = await prisma.aIExtractionLog.aggregate({
    where:  { organizationId, model: 'claude-sonnet-4-6', createdAt: { gte: runStart } },
    _sum:   { estimatedCostUsd: true, inputTokens: true, outputTokens: true },
    _count: { _all: true },
  })

  console.log('\n═══════════════════════════════════════════════════════════════════')
  console.log('Catch-up summary')
  console.log(`  cohort:    ${cohort.length}`)
  console.log(`  processed: ${processed}`)
  console.log(`  produced opps: ${ok}`)
  console.log(`  skipped (NOISE/HOTSHEET/empty): ${skipped}`)
  console.log(`  failed:    ${failed}`)
  console.log(`  Sonnet calls: ${costAgg._count._all}  cost: $${(costAgg._sum.estimatedCostUsd ?? 0).toFixed(4)}  ` +
    `(in=${costAgg._sum.inputTokens ?? 0} out=${costAgg._sum.outputTokens ?? 0})`)
  console.log(`  matchmaker: ${matchSummary}`)
  if (errors.length > 0) {
    console.log(`\n  First ${Math.min(errors.length, 10)} errors:`)
    errors.slice(0, 10).forEach(e => console.log(`    ${e}`))
  }
  if (aborted) console.log('  NOTE: run aborted early by cost guard.')
  console.log('═══════════════════════════════════════════════════════════════════')

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('FATAL:', e)
  await prisma.$disconnect()
  process.exit(1)
})
```

**Execution sequence:**
```bash
cd "/Users/Ram5268/Library/Mobile Documents/com~apple~CloudDocs/Antigravity Projects/dealflow-inbox-intelligence"
# 1. Dry run — counts cohort split, no LLM calls.
INGEST_V2=true npx tsx scripts/catchup-v2-extract.ts --dry-run
# 2. Smoke test 10 emails.
INGEST_V2=true npx tsx scripts/catchup-v2-extract.ts --confirm --limit 10
# 3. Full run with $25 cost cap.
INGEST_V2=true npx tsx scripts/catchup-v2-extract.ts --confirm --max-cost 25 --concurrency 5
```
Do not trigger a Check In sync concurrently with step 3 to avoid a race on shared rows.

## Task 4: Sanity verification after all tasks

Run from the repo root with `DATABASE_URL` resolved from `.env`:

```bash
cd "/Users/Ram5268/Library/Mobile Documents/com~apple~CloudDocs/Antigravity Projects/dealflow-inbox-intelligence"
npx tsx scripts/v1-v2-count.ts
```

Expected post-run state:
- `AIExtractionLog.count({ extractorVersion: '2.0' })` jumped from 869 by hundreds.
- `ExtractedOpportunity.count({ rawEmail: { createdAt: { gte: 2026-06-05T01:07:16Z } } })` went from 0 to several hundred.
- `RawEmail.count({ createdAt: { gte: 2026-06-05T01:07:16Z }, classifierCategory: null })` dropped to ~0 (some may legitimately be NOISE).
- New `ExtractedOpportunity` rows have `createdAt` > the catch-up run start.
- In the browser at `/chat`: a query like "Brooklyn rentals under $5k" produces a noticeably less robotic response than gpt-4o; server logs show `[DealFlow] Sonnet tool_use input keys: response,suggestions,referencedDeals`.

If `[DealFlow] Sonnet returned no tool_use; falling back to text parse` fires on the first turn, investigate the Anthropic SDK type cast on `input_schema`; if it persists across many turns, file a follow-up to switch Drift to prompt-engineered JSON.

## Order of operations

1. Task 1 edits (`ingestEmailV2.ts` classifier wire-in).
2. Run `npx prisma generate && npx tsc --noEmit` — must pass.
3. Task 2 edits (`app/api/chat/route.ts` Drift swap).
4. Run `npx tsc --noEmit` again — must pass.
5. Smoke test the local app at `/chat` for one Drift turn (Task 2 verify).
6. Task 3 file creation.
7. `INGEST_V2=true npx tsx scripts/catchup-v2-extract.ts --dry-run` — read the projected counts.
8. `INGEST_V2=true npx tsx scripts/catchup-v2-extract.ts --confirm --limit 10` — smoke test 10 rows.
9. Inspect logs + DB: confirm new `ExtractedOpportunity` rows have rich V2 shape.
10. `INGEST_V2=true npx tsx scripts/catchup-v2-extract.ts --confirm --max-cost 25 --concurrency 5` — full run.
11. Task 4 verification.

Task 1 MUST precede Task 3 — without the wire-in, the catch-up script's `extractEmailV2` calls would silently no-op on chunk-bearing rows whose classifier never ran (the script's standalone `classifyIfNeeded` covers that, but the live sync pipeline still needs the in-orchestrator classifier so future emails don't silently drop again).

## What this brief does NOT do (out of scope)

- No backfill of the 12,860 existing V1 `ExtractedOpportunity` rows.
- No edit to `app/api/sync/run/route.ts` lines 78-88 (the 30-min `v2Cutoff` is a known latent bug — silently abandons any email whose V2 dispatch failed once outside the window; address in a separate follow-up PR after catch-up succeeds).
- No change to `parseSearchQuery` at `lib/ai.ts:268` (still `gpt-4o-mini`).
- No change to the Drift session-title call at `app/api/chat/route.ts:322` (still `gpt-4o-mini`).
- No restoration of Phase X.1 StreetEasy auto-match (V1-only at `lib/ingestion/ingestEmail.ts:144-172`) — V2 supply-side opportunities land with `streetEasyId=null` and the daily 5:30am cron will eventually backfill them. Flag as P1 follow-up.
- No restoration of V1 duplicate detection (`duplicateOfId` / `isDuplicate`) — V2 currently writes every record as `processingStatus='active'` without dedup. Flag as P1 follow-up.
- No restoration of `SHOWING_CONFIRMATION` calendar-proposal Match generation (`lib/backgroundSync.ts:320-333`, V1-gated). Flag as P1 follow-up.

## Rollback

```bash
cd "/Users/Ram5268/Library/Mobile Documents/com~apple~CloudDocs/Antigravity Projects/dealflow-inbox-intelligence"
git log --oneline -5
git revert <classifier-fix-sha> <drift-swap-sha>
```
Each task lands as a separate commit so they can be reverted independently. The catch-up script is a new file with no dependencies — leaving it in place after revert is harmless.

## Notes for the executor

- `.env` is at the repo root and contains `DATABASE_URL` (Railway PostgreSQL), `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `QDRANT_URL`, `QDRANT_API_KEY`, `FIRECRAWL_API_KEY`, `LLAMAPARSE_API_KEY`, `INGEST_V2=true`. The catch-up script imports `'dotenv/config'` to load it.
- Anthropic SDK version: `@anthropic-ai/sdk: ^0.95.1` (verified in `package.json:20`). The system-array-with-cache_control shape and `tool_choice: { type: 'tool', name }` are both supported in this version.
- `claude-sonnet-4-6` is the model ID already in use by `lib/extraction/sonnetExtractor.ts` — use the same string.
- The cohort uses `createdAt >= GATE_TS` rather than `receivedDateTime` because some emails received before the gate may have arrived in the DB after the gate landed. `createdAt` is the DB-insertion timestamp, which is the truthful boundary.
- The classifier fallback (`category: 'NOISE', confidence: 0`) at `sourceClassifier.ts:119-124` swallows OpenAI errors silently. If the catch-up logs an unusually high NOISE count, check for OpenAI rate-limiting before assuming a misclassification problem.
- Read-only Outlook constraint (`CLAUDE.md`): both the V2 orchestrator and the catch-up script read only from the local DB. No Microsoft Graph requests are issued. Safe under the rule.
- Project memory rule "Prefer stronger model" is satisfied by the Sonnet swap for the user-facing Drift surface; the still-OpenAI `gpt-4o-mini` calls are background-only (session titling, V1 dead-code extractor, search-query parsing) and remain out of scope per the verbatim user ask.