export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { guardChat } from '@/lib/spendGuard'
import { parseQuery } from '@/lib/retrieval/queryParser'
import type { ParsedQuery } from '@/lib/retrieval/types'
import { createCalendarEvent } from '@/lib/microsoftCalendar'
import { graphEnabled } from '@/lib/graphAccess'
import { recentHistoryQuery, oldestFirst, startAtUserTurn } from '@/lib/chat/history'
import { isMatchingTestModeOnly } from '@/lib/config/matchingTestMode'
import { runCalendarConfirm, isCalendarConfirm, CALENDAR_CONFIRM_FAILED } from '@/lib/chat/calendarConfirm'
import { composeContext } from '@/lib/chat/context/composeContext'
import { getStreetEasyUrl } from '@/lib/chat/streetEasyUrls'
import { searchListings, type SearchListingsInput } from '@/lib/chat/tools/searchListings'
import { searchParties, type SearchPartiesInput } from '@/lib/chat/tools/searchParties'
import { SEARCH_LISTINGS_TOOL, SEARCH_PARTIES_TOOL, GENERATE_REPORT_TOOL, GENERATE_REPORT_SECTION_TOOL, FIND_SELLER_TOOL, COUNT_SELLERS_TOOL } from '@/lib/chat/tools/schemas'
import { CRM_SELLER_TOOL_NAMES, newCrmSellerTurn, runCrmSellerTool } from '@/lib/chat/tools/crmSellerTools'
import type { SellerCard } from '@/lib/chat/sellerCard'
import { getTemplate } from '@/lib/reports/templates'
import { getGenerator, type SectionResult } from '@/lib/reports/generators'
import { scanForStructuralHallucinations } from '@/lib/chat/guards/regexGuard'
import { verifyResponse, type ToolResultForVerify } from '@/lib/chat/guards/llmVerifier'
import { buildGroundingCorpus, filterToolBoundFlags } from '@/lib/chat/guards/toolBinding'
import { logGuardFireEvent, timedOutGuardInput } from '@/lib/chat/guards/instrumentation'
import { createTurnBudget, deadlineSignal, withTimeout, isTimedOut, LOOKUP_TIMEOUT_MS, TURN_SOFT_MS, TURN_HARD_MS, TURN_CEILING_MS, TIMED_OUT_REPLY } from '@/lib/chat/turnBudget'
import { buildSystemBlocks, RYAN_MD } from '@/lib/chat/systemBlocks'
import { SYSTEM_PROMPT, VOICE_INSTRUCTION } from '@/lib/chat/systemPrompt'
import {
  MAX_GUARD_RETRIES,
  selectCannedFallback,
  repeatedActionClaim,
  skipVerifierForRepeatClaim,
  skippedVerification,
  buildFeedbackPrompt,
  formatFlagLines,
  type GuardAttempt,
  type GuardTelemetry,
} from '@/lib/chat/guards/retry'
import { DRAFT_FIELD_SCHEMA, buildDraftContext, draftAsText, enforceDraftPrivacy } from '@/lib/chat/guards/draftPrivacy'
import { encodeStoredReply, readStoredReply, storedReplyForModel } from '@/lib/chat/storedReply'
import { normalizeDraft } from '@/lib/chat/draft'
import { cleanReplyText } from '@/lib/chat/replyText'
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'

// Council swap — chat runs on Sonnet 4.6 per CLAUDE.md's product-surface rule
// (swapped from Haiku 4.5 in commit 5fdeb44). Haiku's cost was the reason we
// originally shipped on it, but the 32-query stress test traced its
// prompt-adherence bugs to model choice; Sonnet cleared them.
const CHAT_MODEL = 'claude-sonnet-4-6'
// Sonnet 4.6 list pricing: $3 / 1M input, $15 / 1M output.
const CHAT_INPUT_PER_M = 3
const CHAT_OUTPUT_PER_M = 15
// Safety cap on the tool_use loop — if the model hasn't finished after this many
// search rounds it's spinning; we force a final structured reply.
const MAX_ITERATIONS = 6

export const maxDuration = 60

// Trim a search-tool card down to the fact-bearing fields the guard verifier
// needs to ground Sonnet's response. Drops scoring/UI noise; keeps anything a
// claim could reference (address, price, beds, category, neighborhood, and for
// parties name/phone/title).
function trimCardForGuard(card: Record<string, unknown>): Record<string, unknown> {
  const keep = ['id', 'category', 'title', 'address', 'neighborhood', 'beds', 'price', 'priceRange', 'name', 'phone', 'role', 'units', 'propertyType', 'squareFeet', 'availabilityDate', 'sourceBrokerage'] as const
  const out: Record<string, unknown> = {}
  for (const k of keep) {
    if (card[k] !== undefined && card[k] !== null) out[k] = card[k]
  }
  return out
}

interface FileData {
  name: string
  mimeType: string
  type: 'image' | 'text' | 'binary'
  content: string // base64 for image/binary, plain text for text
}

async function parseBinary(buffer: Buffer, filename: string, mimeType: string): Promise<string> {
  try {
    if (/\.docx$/i.test(filename) || mimeType.includes('wordprocessingml')) {
      const mammoth = require('mammoth')
      const result = await mammoth.extractRawText({ buffer })
      return result.value ?? ''
    }
    if (/\.(xlsx|xls)$/i.test(filename) || mimeType.includes('spreadsheetml') || mimeType.includes('ms-excel')) {
      const XLSX = require('xlsx')
      const wb = XLSX.read(buffer, { type: 'buffer' })
      return wb.SheetNames.map((n: string) =>
        `--- Sheet: ${n} ---\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`
      ).join('\n')
    }
    return `(File "${filename}" — binary format not yet supported for text extraction)`
  } catch (e) {
    console.error(`[DealFlow] parseBinary error:`, e)
    return `(Could not parse "${filename}")`
  }
}

export async function POST(req: NextRequest) {
  // Brief 43 PR 4: the turn's clock (createTurnBudget below) starts here, so
  // guardChat's database checks count against the 52 s budget too.
  const t0 = Date.now()
  // Brief 43 PR 17 [engineering precaution]: DealFlow has no login [Ryan,
  // 2026-09-24], so the daily spend cap and per-address limits run first,
  // before the parser (a paid call), Claude, or any session work. See
  // lib/spendGuard.ts.
  const spendRefusal = await guardChat(req)
  if (spendRefusal) return spendRefusal
  try {
    const body = await req.json()
    const userMessage: string = (body.message ?? '').trim()
    const files: FileData[] = body.files ?? []

    if (!userMessage && files.length === 0) {
      return NextResponse.json({ error: 'Message or file required' }, { status: 400 })
    }

    const organizationId = await getCurrentOrgId()

    // Resolve the session. Brief 43 PR 4 (Q4): a new chat's row is created only
    // when something is saved to it (this turn's messages, or a report), so a
    // turn that runs out of time leaves no empty chat in History [engineering
    // precaution]. ensureSession creates it once, however many callers ask.
    const sessionId: string | undefined = body.sessionId
    let session = sessionId
      ? await prisma.chatSession.findUnique({ where: { id: sessionId } })
      : null
    let creatingSession: Promise<NonNullable<typeof session>> | null = null
    const ensureSession = async () =>
      session ?? (session = await (creatingSession ??= prisma.chatSession.create({ data: { organizationId } })))

    // Load conversation history for this session only: the newest 30 messages,
    // oldest first (Brief 41: it used to be the oldest 30).
    const history = session ? oldestFirst(await prisma.chatMessage.findMany(recentHistoryQuery(session.id))) : []

    // Normalize query text used for retrieval + side-channel triggers
    const queryText = (userMessage || files.map(f => f.name).join(' ')).toLowerCase().trim()

    // ── Brief 3.0: lightweight parse drives the side-channels only ───────────
    // The lossy parseQuery → rigid-SQL → 25-cap card retrieval (runRetrieval) is
    // gone; Sonnet's search_listings / search_parties tools now find the cards.
    // We still call parseQuery here to feed composeContext's side-channels
    // (live StreetEasy, Mojo, mortgage, calendar, ACRIS, DOB) — those are
    // orthogonal features preserved from the old pipeline.
    let parsed: ParsedQuery
    try {
      parsed = await parseQuery(queryText)
    } catch (err) {
      console.error('[chat] parseQuery error (side-channels degrade gracefully):', err)
      parsed = {
        raw: queryText, neighborhoods: [], boroughs: [],
        beds: null, minBeds: null, maxBeds: null, minUnits: null, maxUnits: null,
        minPrice: null, maxPrice: null, isRental: null, categories: [],
        intent: 'general', isCalendar: false, isACRIS: false, isDOB: false,
        isMyBuyer: false, isSellerLead: false, isEmailCampaign: false,
        broaden: false, freshnessOverrideHours: null, usedLLM: false, confidence: 0,
      }
    }

    // Calendar confirmation check — based on message history, not query intent
    const lastAssistantMsg = history.filter(m => m.role === 'assistant').slice(-1)[0]
    let lastPendingEvent: Record<string, string> | null = null
    if (lastAssistantMsg?.content) {
      try {
        const assistantJson = JSON.parse(lastAssistantMsg.content)
        if (assistantJson?.pendingEvent) lastPendingEvent = assistantJson.pendingEvent
      } catch { /* not JSON */ }
    }
    // Brief 41 (M17): only a short, plain yes confirms; anything else (a "no",
    // a change of time, a question) goes to Drift as a normal message.
    const isConfirmMessage = lastPendingEvent != null && isCalendarConfirm(userMessage)

    // ── Calendar confirm fast-path: create the pending event directly, skip LLM + all context fetches ──
    // Brief 8.0-lite Fix #2 — the actual write + audit + guard moved into
    // runCalendarConfirm (injectable, unit-tested). The two-step gate (a plain
    // yes via isCalendarConfirm + lastPendingEvent) stays inline above.
    if (isConfirmMessage && lastPendingEvent) {
      // Always an existing chat: the pending event came from its history.
      const confirmSession = await ensureSession()
      try {
        const result = await runCalendarConfirm({
          organizationId,
          sessionId: confirmSession.id,
          userMessage,
          // Brief 43 PR 14 (F9): when the proposal was made, for its expiry check.
          proposedAt: lastAssistantMsg?.createdAt ?? null,
          pendingEvent: {
            subject:  lastPendingEvent.subject,
            startISO: lastPendingEvent.startISO,
            endISO:   lastPendingEvent.endISO,
            location: lastPendingEvent.location,
            notes:    lastPendingEvent.notes,
          },
          deps: {
            alreadyWritten: (sid, ev) =>
              prisma.auditLog
                .findFirst({
                  where: {
                    organizationId,
                    action: 'CALENDAR_WRITE',
                    AND: [
                      { detailsJson: { path: ['sessionId'], equals: sid } },
                      { detailsJson: { path: ['startISO'], equals: ev.startISO } },
                      { detailsJson: { path: ['subject'], equals: ev.subject } },
                    ],
                  },
                  select: { id: true },
                })
                .then(Boolean),
            graphOn:        graphEnabled(),
            testModeOn:     isMatchingTestModeOnly(),
            createEvent:    createCalendarEvent,
            createMessage:  (data) => prisma.chatMessage.create({ data: data as never }),
            createAuditLog: (data) => prisma.auditLog.create({ data: data as never }),
            touchSession:   (id) => prisma.chatSession.update({ where: { id }, data: { updatedAt: new Date() } }),
          },
        })
        return NextResponse.json({ sessionId: confirmSession.id, response: result.text, deals: [] })
      } catch (err) {
        // Brief 41 (M17): never fall through to the AI after a failed confirm (it
        // could claim the event was booked). runCalendarConfirm only throws
        // before the calendar write (after it, failures are logged and the
        // "Done" reply still goes out), so nothing was booked.
        console.error('[DealFlow] Calendar confirm error:', err)
        return NextResponse.json({ sessionId: confirmSession.id, response: CALENDAR_CONFIRM_FAILED, deals: [] })
      }
    }

    // ── Compose all 7 side-channel context blocks in parallel (PR 5) ─────────
    // Mortgage, ACRIS, DOB, calendar, matches, liveStreetEasy, mojo.
    // Each fetcher has its own try/catch; per-fetcher failures are isolated.
    const composed = await composeContext({
      parsed,
      userMessage,
      queryText,
      isConfirmMessage,
    })

    // Cards are hydrated AFTER the tool_use loop (from the ids Sonnet's tools
    // actually returned), not pre-fetched from a retrieval pool.
    const oppIncludeForCards = { rawEmail: { select: { receivedDateTime: true, bodyContent: true, attachmentsText: true } } }

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

    // ── System prompt: SYSTEM_PROMPT + RYAN_MD cached; dynamic side-channel block uncached ──
    // The dynamic block carries composeContext's side-channels (live StreetEasy,
    // Mojo, mortgage, calendar, ACRIS, DOB). Cards are NOT injected here anymore
    // — Sonnet pulls them via the search tools. RYAN_MD (Brief 29.0) is a static
    // personal glossary added as a second cached block by buildSystemBlocks.
    const dynamicSystemBlock = [composed.pre, composed.post].filter(Boolean).join('\n\n').trim()
    const voiceBlock = body.voice === true ? VOICE_INSTRUCTION : ''
    const systemBlocks = buildSystemBlocks(SYSTEM_PROMPT, [dynamicSystemBlock, voiceBlock].filter(Boolean).join('\n\n'))

    // ── Tool definition for the final structured reply ──
    const RESPONSE_TOOL_NAME = 'drift_response'
    const responseTool: Anthropic.Messages.Tool = {
      name: RESPONSE_TOOL_NAME,
      description: "Return Drift's FINAL reply to Ryan as structured JSON. Call this exactly once, alone, after you have searched. Do not call it in the same turn as a search.",
      input_schema: {
        type: 'object',
        properties: {
          response: {
            type: 'string',
            description: 'Plain text response. No markdown, no bold, no italics, no bullet dashes, no em-dashes, no exclamation marks.',
          },
          // Brief 43 PR 14: no follow-up suggestions (D7, a Brief 42 default),
          // and a calendar proposal only while Outlook is on (D8, Q33).
          ...(graphEnabled() ? {
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
          } : {}),
          referencedDeals: {
            type: 'array',
            items: { type: 'string' },
            description: 'Exact card ids you mentioned (e.g. SEED_SALE_06). Traceability only — does not gate which cards Ryan sees.',
          },
          // Brief 27.0 — report attachments. Fill attachedReport ONLY on a turn you
          // just called generate_report; fill attachedFragment ONLY on a turn you
          // just called generate_report_section. The server also captures these
          // server-side, so echo the ids you were given in the tool result.
          attachedReport: {
            type: 'object',
            description: 'Set only when you just generated a FULL report this turn.',
            properties: {
              reportId:     { type: 'string' },
              templateId:   { type: 'string' },
              templateName: { type: 'string' },
              subject:      { type: 'string' },
              sectionCount: { type: 'number' },
              matchCount:   { type: 'number' },
            },
            required: ['reportId', 'templateId'],
          },
          attachedFragment: {
            type: 'object',
            description: 'Set only when you just generated a single report SECTION this turn.',
            properties: {
              templateId: { type: 'string' },
              sectionKey: { type: 'string' },
              title:      { type: 'string' },
            },
            required: ['templateId', 'sectionKey'],
          },
          // Brief 43 PR 3 (Q3) — an email or text to copy, apart from the reply;
          // its rules are in the field's description (lib/chat/guards/draftPrivacy.ts).
          draft: DRAFT_FIELD_SCHEMA,
        },
        required: ['response', 'referencedDeals'],
      } as Anthropic.Messages.Tool.InputSchema,
    }

    // Brief 41: the model's conversation must start with a user turn.
    // Brief 43 PR 3 (review r1): a reply stored as JSON (a draft) goes to the model
    // as its text plus the draft, the way the draft rewrite shows it, not as JSON.
    const anthropicHistory: Anthropic.Messages.MessageParam[] = startAtUserTurn(history).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.role === 'assistant' ? storedReplyForModel(m.content) : m.content,
    }))

    // ── Sonnet 4.6 tool_use loop ─────────────────────────────────────────────
    // tool_choice='any' forces a tool call every turn, so the loop deterministically
    // terminates on drift_response (Sonnet's structured final reply) rather than a
    // free-text end_turn. This preserves the calendar pendingEvent.
    type AttachedReport = { reportId: string; templateId: string; templateName: string; subject: string; sectionCount: number; matchCount?: number }
    type AttachedFragment = { templateId: string; sectionKey: string; title: string; content: SectionResult['content']; sources: SectionResult['sources'] }
    type AiResult = { response: string; pendingEvent?: Record<string, string> | null; referencedDeals?: string[]; attachedReport?: AttachedReport; attachedFragment?: AttachedFragment }
    const tools: Anthropic.Messages.Tool[] = [SEARCH_LISTINGS_TOOL, SEARCH_PARTIES_TOOL, FIND_SELLER_TOOL, COUNT_SELLERS_TOOL, GENERATE_REPORT_TOOL, GENERATE_REPORT_SECTION_TOOL, responseTool]
    // Brief 43 PR 5 (D11 [Ryan, 2026-10-18]): the one named CRM seller find_seller
    // returned this turn, as structured cards for the page (name, phone, address,
    // Open in CRM link). Never put in Drift's text: any URL there trips the guard (Q19).
    const sellerCards: SellerCard[] = []
    const crmSellerTurn = newCrmSellerTurn() // one seller contact per message (crmSellerTools.ts)
    // Brief 27.0 — server-authoritative capture of the report/fragment produced
    // this turn. We persist + return THESE (not whatever Sonnet echoes) so ids
    // are always correct and the attachment survives guard rewrites.
    let serverAttachedReport: AttachedReport | null = null
    let serverAttachedFragment: AttachedFragment | null = null
    // Brief 43 PR 4: report saves under way (handleReportTool). A turn that runs
    // out of time waits briefly for them, so its chat and reply carry the report
    // and nothing is written after the reply [engineering precaution].
    const reportSaves: Promise<void>[] = []
    const messages: Anthropic.Messages.MessageParam[] = [
      ...anthropicHistory,
      { role: 'user', content: userBlocks },
    ]
    // Every card Sonnet saw across all tool calls, deduped by id (order preserved).
    const allToolCalls: Array<{ name: string; input: unknown; totalMatched: number; cardIds: string[] }> = []
    // Trimmed tool outputs for the hallucination guard's verifier — the exact
    // grounding Sonnet had. Kept compact (id/address/price/beds/category/hood
    // + party name/phone) to keep verifier token cost near-zero.
    const toolResultsForGuard: ToolResultForVerify[] = []
    const seenCardIds = new Set<string>()
    const cardOverlap = new Map<string, number>()   // id → priceOverlapScore (for matchScore)
    let tokensIn = 0
    let tokensOut = 0
    let aiResult: AiResult | null = null
    let maxIterationsHit = false

    async function runSearchTool(name: string, input: unknown): Promise<{ cards: Array<{ id: string; priceOverlapScore?: number }>; totalMatched: number }> {
      if (name === 'search_listings') return searchListings(input as SearchListingsInput)
      if (name === 'search_parties')  return searchParties(input as SearchPartiesInput)
      return { cards: [], totalMatched: 0 }
    }

    // Brief 27.0 — report tool dispatch. generate_report saves a Report row and
    // captures serverAttachedReport; generate_report_section returns the section
    // content inline and captures serverAttachedFragment. Both push their output
    // into toolResultsForGuard so the guard treats the restated content as
    // grounded. Returns the JSON the model sees as the tool_result.
    async function handleReportTool(tu: Anthropic.Messages.ToolUseBlock): Promise<unknown> {
      const input = tu.input as { templateId?: string; sectionKey?: string; params?: Record<string, unknown> }
      const templateId = input.templateId ?? ''
      const params = input.params ?? {}
      const template = getTemplate(templateId)
      if (!template) return { error: `Unknown template: ${templateId}` }
      if (!template.isUnlocked) return { error: `Report ${templateId} not yet available — waiting on: ${template.dataRequirements.join(', ')}` }
      const generator = getGenerator(templateId)
      if (!generator) return { error: `No generator registered for ${templateId}` }
      const buyerId = typeof params.buyerId === 'string' ? params.buyerId : null

      if (tu.name === 'generate_report') {
        const generated = await generator.full({ ...params, prisma, anthropic })
        // Brief 43 PR 4: a report finished after the turn's ceiling isn't saved;
        // the reply (TIMED_OUT_REPLY) has gone, and a late save would leave a
        // chat with no messages in History [engineering precaution].
        if (budget.msLeft(TURN_CEILING_MS) === 0) throw new Error('out of time')
        const saving = (async () => {
          const saved = await prisma.report.create({
            data: {
              templateId,
              params: params as object,
              sections: generated.sections as unknown as object,
              markdown: generated.markdown,
              sources: generated.sources as unknown as object,
              sessionId: (await ensureSession()).id, // Brief 43 PR 4: a report's chat is saved with it
              buyerId,
            },
            select: { id: true },
          })
          serverAttachedReport = {
            reportId: saved.id, templateId, templateName: template.name,
            subject: generated.subject, sectionCount: generated.sections.length, matchCount: generated.matchCount,
          }
          return saved
        })()
        reportSaves.push(saving.then(() => undefined, () => undefined))
        const report = await saving
        const result = {
          reportId: report.id, templateName: template.name, subject: generated.subject,
          sectionCount: generated.sections.length, matchCount: generated.matchCount, saved: true,
        }
        toolResultsForGuard.push({ name: tu.name, input: tu.input, output: result })
        return result
      }

      // generate_report_section
      const sectionKey = input.sectionKey ?? ''
      const section = await generator.section({ ...params, sectionKey, prisma, anthropic })
      serverAttachedFragment = { templateId, sectionKey, title: section.title, content: section.content, sources: section.sources }
      const result = { templateId, sectionKey, title: section.title, content: section.content }
      toolResultsForGuard.push({ name: tu.name, input: tu.input, output: result })
      return result
    }

    // ── Brief 43 PR 4 (Q4; M23): the turn's time budget, from the request's start ──
    // Past TURN_SOFT_MS (40 s) no more tool rounds; past TURN_HARD_MS (50 s) no
    // new model call; at TURN_CEILING_MS (52 s) any call or tool round still
    // running is cut off, well inside Vercel's 60 s (lib/chat/turnBudget.ts)
    // [engineering precaution].
    const budget = createTurnBudget(t0, { softMs: TURN_SOFT_MS, hardMs: TURN_HARD_MS })
    const turnDeadline = deadlineSignal(budget.msLeft(TURN_CEILING_MS))
    // Every model call goes through withinTurn: cut off at the ceiling (the signal
    // stops the request; the timeout also covers an SDK retry wait, which ignores
    // the signal), or after capMs if sooner, it resolves to null. Any other
    // failure still throws.
    const withinTurn = async <T>(call: Promise<T>, capMs = Infinity): Promise<T | null> => {
      try {
        const result = await withTimeout(call, Math.min(capMs, budget.msLeft(TURN_CEILING_MS)), 'model call')
        return isTimedOut(result) ? null : result
      } catch (err) {
        if (turnDeadline.signal.aborted) return null
        throw err
      }
    }
    let softCut = false           // the soft deadline ended the tool rounds
    let factCheckSkipped = false  // the hard deadline skipped (or cut off) a fact-check

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (budget.pastSoft()) { softCut = true; break } // Brief 43 PR 4: Drift writes its reply now
      const completion = await withinTurn(anthropic.messages.create({
        model: CHAT_MODEL,
        max_tokens: 4096,
        system: systemBlocks,
        messages,
        tools,
        tool_choice: { type: 'any' },
      }, { signal: turnDeadline.signal }))
      if (!completion) break // cut off at the ceiling: the turn ends with TIMED_OUT_REPLY below
      tokensIn  += completion.usage?.input_tokens  ?? 0
      tokensOut += completion.usage?.output_tokens ?? 0

      // drift_response = terminal. Take it even if searches appear in the same turn
      // (we instruct against that; finalizing avoids an unmatched-tool_use error).
      const driftUse = completion.content.find(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use' && b.name === RESPONSE_TOOL_NAME,
      )
      if (driftUse) { aiResult = driftUse.input as AiResult; break }

      const REPORT_TOOL_NAMES = new Set(['generate_report', 'generate_report_section'])
      const toolUses = completion.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock =>
          b.type === 'tool_use' &&
          (b.name === 'search_listings' || b.name === 'search_parties' || REPORT_TOOL_NAMES.has(b.name) || CRM_SELLER_TOOL_NAMES.has(b.name)),
      )
      if (toolUses.length === 0) break  // shouldn't happen under tool_choice='any'

      messages.push({ role: 'assistant', content: completion.content })
      // Brief 43 PR 4: the tool round is on the turn's clock too. A report (its
      // own Sonnet call) or a search still running at the ceiling ends the turn
      // with TIMED_OUT_REPLY below [engineering precaution].
      const toolRound = await withTimeout(Promise.all(
        toolUses.map(async (tu) => {
          // Report tools (generate_report / generate_report_section) run + save here.
          if (REPORT_TOOL_NAMES.has(tu.name)) {
            try {
              const output = await handleReportTool(tu)
              allToolCalls.push({ name: tu.name, input: tu.input, totalMatched: 0, cardIds: [] })
              return { type: 'tool_result' as const, tool_use_id: tu.id, content: JSON.stringify(output) }
            } catch (e) {
              console.error(`[chat] report tool ${tu.name} failed:`, e)
              return { type: 'tool_result' as const, tool_use_id: tu.id, content: JSON.stringify({ error: String(e) }), is_error: true }
            }
          }

          // Brief 43 PR 5: find_seller / count_sellers. The guard (and PR 3's
          // draft check) get the full result; Drift reads it without the CRM link.
          if (CRM_SELLER_TOOL_NAMES.has(tu.name)) {
            try {
              const run = await runCrmSellerTool(tu.name, tu.input, crmSellerTurn)
              allToolCalls.push({ name: tu.name, input: tu.input, totalMatched: run.totalMatched, cardIds: run.card ? [run.card.id] : [] })
              toolResultsForGuard.push({ name: tu.name, input: tu.input, output: run.output })
              if (run.card && !sellerCards.some(c => c.id === run.card!.id)) sellerCards.push(run.card)
              return { type: 'tool_result' as const, tool_use_id: tu.id, content: JSON.stringify(run.forModel) }
            } catch (e) {
              console.error(`[chat] tool ${tu.name} failed:`, e)
              return { type: 'tool_result' as const, tool_use_id: tu.id, content: JSON.stringify({ error: String(e) }), is_error: true }
            }
          }

          let output: { cards: Array<{ id: string; priceOverlapScore?: number }>; totalMatched: number }
          try {
            output = await runSearchTool(tu.name, tu.input)
          } catch (e) {
            console.error(`[chat] tool ${tu.name} failed:`, e)
            return { type: 'tool_result' as const, tool_use_id: tu.id, content: JSON.stringify({ error: String(e) }), is_error: true }
          }
          allToolCalls.push({ name: tu.name, input: tu.input, totalMatched: output.totalMatched, cardIds: output.cards.map(c => c.id) })
          toolResultsForGuard.push({
            name: tu.name,
            input: tu.input,
            output: {
              cards: (output.cards as Array<Record<string, unknown>>).map(trimCardForGuard),
              totalMatched: output.totalMatched,
              // Brief 43 PR 7: "N more have no unit count on file" is grounded too.
              ...('notOnFile' in output ? { notOnFile: output.notOnFile } : {}),
            },
          })
          for (const c of output.cards) {
            if (!seenCardIds.has(c.id)) seenCardIds.add(c.id)
            if (c.priceOverlapScore !== undefined && !cardOverlap.has(c.id)) cardOverlap.set(c.id, c.priceOverlapScore)
          }
          return { type: 'tool_result' as const, tool_use_id: tu.id, content: JSON.stringify(output) }
        }),
      ), budget.msLeft(TURN_CEILING_MS), 'tool round')
      if (isTimedOut(toolRound)) break
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = toolRound
      messages.push({ role: 'user', content: toolResults })

      if (iter === MAX_ITERATIONS - 1) maxIterationsHit = true
    }

    // Force a final structured reply if the loop exhausted its budget without one.
    // Brief 43 PR 4: also when the soft deadline ended the tool rounds; past the
    // hard deadline no new model call starts, and the turn ends below.
    if (!aiResult && !budget.pastHard()) {
      console.warn(softCut
        ? '[chat] soft deadline reached, forcing final reply'
        : '[chat] MAX_ITERATIONS reached without drift_response — forcing final reply')
      if (!softCut) maxIterationsHit = true
      const forced = await withinTurn(anthropic.messages.create({
        model: CHAT_MODEL,
        max_tokens: 4096,
        system: systemBlocks,
        messages,
        tools: [responseTool],
        tool_choice: { type: 'tool', name: RESPONSE_TOOL_NAME },
      }, { signal: turnDeadline.signal }))
      tokensIn  += forced?.usage?.input_tokens  ?? 0
      tokensOut += forced?.usage?.output_tokens ?? 0
      const forcedUse = forced?.content.find(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use' && b.name === RESPONSE_TOOL_NAME,
      )
      if (forced) aiResult = (forcedUse?.input as AiResult) ?? { response: 'Sorry, I had trouble pulling that together. Try rephrasing?', referencedDeals: [] }
    }

    // ── Brief 43 PR 4 (Q4): out of time before Drift had a reply ──────────────
    // Nothing is saved to the chat, so a new chat leaves no empty row in History
    // and an existing one stays as it was; unless this turn already saved a
    // report (or started saving one, which made the chat row), then the exchange
    // is saved so the chat isn't empty and the report stays reachable.
    // Written: one counts-only guard-log row (verdict 'timeout') and the usual
    // spend row, so a daily cap still counts the turn [engineering precaution].
    if (!aiResult) {
      const elapsedMs = Date.now() - t0
      // A report save that started before the ceiling: give it up to 2 s to land.
      if (reportSaves.length > 0) await withTimeout(Promise.all(reportSaves), 2_000, 'report save')
      if (serverAttachedReport || serverAttachedFragment || creatingSession) {
        const reportSession = await ensureSession()
        const storedUserMsg = files.length > 0 ? `${userMessage} [📎 ${files.map(f => f.name).join(', ')}]` : userMessage
        await prisma.chatMessage.create({ data: { organizationId, sessionId: reportSession.id, role: 'user', content: storedUserMsg } })
        await prisma.chatMessage.create({
          data: {
            organizationId, sessionId: reportSession.id, role: 'assistant', content: TIMED_OUT_REPLY,
            attachedReport:   (serverAttachedReport ?? undefined) as unknown as object | undefined,
            attachedFragment: (serverAttachedFragment ?? undefined) as unknown as object | undefined,
          },
        })
      }
      const timedOutSessionId = session?.id ?? null
      await logGuardFireEvent(timedOutGuardInput({
        organizationId, sessionId: timedOutSessionId, elapsedMs, toolCalls: allToolCalls, finalResponseSent: TIMED_OUT_REPLY,
      }))
      let timedOutInteractionId: string | null = null
      try {
        const interaction = await prisma.driftInteraction.create({
          data: {
            query:          userMessage || queryText,
            parsedFilters:  { toolCalls: allToolCalls, maxIterationsHit, timedOut: true } as unknown as object,
            topCards:       [],
            responseTimeMs: elapsedMs,
            modelUsed:      CHAT_MODEL,
            tokensIn,
            tokensOut,
            // Same formula as the interaction row at the end of the turn.
            costUsd:        (tokensIn / 1_000_000) * CHAT_INPUT_PER_M + (tokensOut / 1_000_000) * CHAT_OUTPUT_PER_M,
          },
          select: { id: true },
        })
        timedOutInteractionId = interaction.id
      } catch (err) {
        console.error('[DealFlow] DriftInteraction logging failed (non-fatal):', err)
      }
      turnDeadline.clear()
      return NextResponse.json({
        sessionId: timedOutSessionId, interactionId: timedOutInteractionId, response: TIMED_OUT_REPLY,
        deals: [], seListings: [], seFilterUrl: null,
        attachedReport: serverAttachedReport, attachedFragment: serverAttachedFragment, draft: null,
      })
    }

    // ── Brief 5.1 — Hallucination guard (regex + Sonnet verifier, informed retry) ──
    // Runs on every final response: scan for structural hallucinations (URLs,
    // external source citations, invented LLC/ownership, dated sale amounts) and
    // fact-check remaining claims against the exact tool results Sonnet saw. On a
    // flag, feed the specific claims back and force a fresh drift_response; after
    // MAX_GUARD_RETRIES, return a canned honest-decline. Telemetry is logged even
    // on clean passes (parsedFilters.guard). Runtime kill switch:
    // HALLUCINATION_GUARD_ENABLED=false. Calendar turns are skipped — the confirm
    // fast-path returns earlier, and a proposal's pendingEvent date/time
    // legitimately isn't in tool results, so guarding it would false-positive.
    // Outlook is paused (Brief 41): drop any calendar proposal, so this turn is
    // guarded like any other and a later "yes" can't hit the confirm path.
    if (!graphEnabled()) aiResult.pendingEvent = null
    const guardEnabled = process.env.HALLUCINATION_GUARD_ENABLED !== 'false'
    const guardApplies = guardEnabled && !aiResult.pendingEvent
    let currentResponse = aiResult.response ?? ''
    // Brief 43 PR 3 (review r1): the draft goes through the fact-check with the
    // reply (the verifier only; the regex scan and PR 2's never-sent check read
    // the reply alone), and a guard rewrite may correct it.
    let currentDraft: unknown = (aiResult as { draft?: unknown }).draft
    const withDraft = (response: string, draft: unknown) => {
      const d = normalizeDraft(draft)
      return d ? draftAsText(response, d) : response
    }
    // Brief 11.0 Fix #2 — the first thing Sonnet tried to say, before any guard
    // correction/fallback overwrites currentResponse. Logged for guard-fire audit.
    const assistantAttempt = currentResponse
    const guardHistory: GuardAttempt[] = []
    let fellbackToCanned = false
    let guardFinalAttempt = 0
    let latestReferenced: string[] | undefined

    // Brief 11.0 Fix #1 — grounding corpus for tool-output binding. A structural
    // entity flag (LLC/owner name) that traces to THIS turn's tool output or the
    // prior turn's DEAL CARDS is grounded, not a hallucination. Built once —
    // tool results don't change across guard retries.
    const priorDealCards = (lastAssistantMsg as { dealsJson?: unknown } | undefined)?.dealsJson ?? null
    // Brief 26.0 — the dynamic system block (live ACRIS/DOB/FRED/Mojo/calendar
    // side-channels) is grounded evidence too. Fold it into the guard's corpus
    // AND hand it to the semantic verifier so a claim quoting side-channel data
    // isn't flagged as a hallucination and forced to the canned fallback.
    // Extracted once here so the same text is reused across both guard calls and
    // every retry-loop iteration below.
    // Brief 29.0 — RYAN_MD is always-on grounded evidence too (same principle):
    // vocabulary Sonnet draws from the personal glossary ("hot matches",
    // "off-market", neighborhood shorthand) must not be flagged as hallucinated.
    // Fold it in ahead of the per-turn dynamic block.
    const sideChannelText = [RYAN_MD, dynamicSystemBlock].filter(Boolean).join('\n\n') || null
    const groundingCorpus = buildGroundingCorpus(toolResultsForGuard, priorDealCards, sideChannelText)

    if (guardApplies) {
      let attempt = 0
      while (attempt <= MAX_GUARD_RETRIES) {
        const regexFlags = filterToolBoundFlags(
          // Brief 43 PR 2: the user's message lets the never-sent check read
          // "Done" after a send request ("send it") as a claim.
          scanForStructuralHallucinations(currentResponse, { userMessage }),
          groundingCorpus,
        )
        // Brief 43 PR 2: a repeated action claim gets NEVER_SENT_REPLY whatever
        // the fact-check says, so skip that paid call. Brief 43 PR 3: the
        // fact-check reads the reply plus its draft. Brief 43 PR 4: past the hard
        // deadline the fact-check doesn't start, and one still running at the
        // ceiling is dropped; the reply is then regex-checked only [engineering
        // precaution].
        const skipRepeat = skipVerifierForRepeatClaim(guardHistory, regexFlags)
        const checked = budget.pastHard() || skipRepeat
          ? null
          : await withTimeout(
              verifyResponse(userMessage || queryText, toolResultsForGuard, sideChannelText, withDraft(currentResponse, currentDraft)),
              budget.msLeft(TURN_CEILING_MS), 'fact-check')
        if (!skipRepeat && (!checked || isTimedOut(checked))) factCheckSkipped = true
        const verifier = skipRepeat
          ? skippedVerification()
          : checked && !isTimedOut(checked) ? checked : { isGrounded: true, flags: [], costUsd: 0, latencyMs: 0 }
        guardHistory.push({ attempt, regexFlags, verifierFlags: verifier.flags, verifierCost: verifier.costUsd })
        if (regexFlags.length === 0 && verifier.isGrounded) break

        attempt++
        // Brief 43 PR 2: a second "sent / booked / done" claim gets the fixed
        // NEVER_SENT_REPLY now, not another rewrite [Ryan, 2026-09-24].
        // Brief 43 PR 4: past the hard deadline, no rewrite either.
        if (attempt > MAX_GUARD_RETRIES || repeatedActionClaim(guardHistory) || budget.pastHard()) {
          // Contextual fallback — pick the variant matching what the final
          // attempt actually flagged (never-sent vs public-records vs finance
          // vs self-description vs generic) instead of always assuming records.
          const finalFlags = guardHistory[guardHistory.length - 1]
          currentResponse = selectCannedFallback({
            regexFlags: finalFlags?.regexFlags ?? [],
            verifierFlags: finalFlags?.verifierFlags ?? [],
          })
          fellbackToCanned = true
          break
        }

        // Informed retry — feed the flagged claims back and force a fresh
        // drift_response (no new searches; restate only grounded facts).
        const flagLines = formatFlagLines(regexFlags, verifier.flags)
        const retryMessages: Anthropic.Messages.MessageParam[] = [
          ...messages,
          { role: 'assistant', content: withDraft(currentResponse, currentDraft) },
          { role: 'user', content: buildFeedbackPrompt(flagLines) },
        ]
        const retry = await withinTurn(anthropic.messages.create({
          model: CHAT_MODEL,
          max_tokens: 4096,
          system: systemBlocks,
          messages: retryMessages,
          tools,
          tool_choice: { type: 'tool', name: RESPONSE_TOOL_NAME },
        }, { signal: turnDeadline.signal }))
        if (!retry) {
          // Brief 43 PR 4: cut off at the ceiling mid-rewrite. The last attempt
          // was flagged, so the stock reply goes out, as when retries run out.
          const last = guardHistory[guardHistory.length - 1]
          currentResponse = selectCannedFallback({ regexFlags: last?.regexFlags ?? [], verifierFlags: last?.verifierFlags ?? [] })
          fellbackToCanned = true
          break
        }
        tokensIn  += retry.usage?.input_tokens  ?? 0
        tokensOut += retry.usage?.output_tokens ?? 0
        const retryUse = retry.content.find(
          (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use' && b.name === RESPONSE_TOOL_NAME,
        )
        const retryResult = retryUse?.input as AiResult | undefined
        if (retryResult) {
          currentResponse   = retryResult.response ?? currentResponse
          currentDraft      = (retryResult as { draft?: unknown }).draft ?? currentDraft
          latestReferenced  = retryResult.referencedDeals ?? latestReferenced
        }
      }
      guardFinalAttempt = attempt
    }

    // Fold the guard's final text (corrected / canned / unchanged) back into aiResult.
    aiResult = {
      ...aiResult,
      response:        currentResponse,
      referencedDeals: latestReferenced ?? aiResult.referencedDeals,
    }

    const guardTelemetry: GuardTelemetry = {
      enabled:              guardEnabled,
      finalAttempt:         guardFinalAttempt,
      fellbackToCanned,
      history:              guardHistory,
      totalVerifierCostUsd: guardHistory.reduce((a, h) => a + h.verifierCost, 0),
    }

    // Brief 43 PR 4: a new chat's row is made now, just before this turn's
    // messages are saved below.
    session = await ensureSession()

    // Brief 11.0 Fix #2 — one guard-fire row per guarded turn (pass / retry /
    // canned_fallback). Fire-and-forget: logGuardFireEvent swallows its own
    // errors, and we don't await it so instrumentation never adds latency or
    // blocks the response. Skipped on turns the guard didn't run (calendar
    // proposals, kill switch off).
    if (guardApplies) {
      void logGuardFireEvent({
        organizationId,
        sessionId:          session.id,
        userTurn:           userMessage || queryText,
        priorAssistantTurn: lastAssistantMsg?.content ?? null,
        assistantAttempt,
        toolCallsAttempted: allToolCalls,
        telemetry:          guardTelemetry,
        finalResponseSent:  currentResponse,
      })
    }

    // ── Brief 43 PR 3 (Q3, spot #17) — draft privacy ─────────────────────────
    // A draft (an email or text for Ryan to copy; nothing is sent [Ryan,
    // 2026-09-24]) comes back in drift_response.draft, apart from the reply the
    // guard above checked. It's held to the rules for anything sent against this
    // turn's CRM homeowners, the street addresses Ryan typed and the listings
    // found (lib/chat/guards/draftPrivacy.ts). A failed check gets one rewrite
    // with feedback (a forced drift_response, like the guard's retry), then the
    // deterministic clean-up, or a short decline. A canned guard fallback drops
    // the draft along with the reply it came with.
    const replyBeforeDraftCheck = aiResult.response ?? ''
    const draftResult = await enforceDraftPrivacy({
      draft:    fellbackToCanned ? null : currentDraft,
      response: replyBeforeDraftCheck,
      ctx:      buildDraftContext({ toolResults: toolResultsForGuard, userMessage, history, contextBlock: dynamicSystemBlock }),
      // Brief 43 PR 4: no draft rewrite past the hard deadline (no new model
      // call), and one still running at the ceiling is cut off; the
      // deterministic clean-up then stands [engineering precaution].
      allowRewrite: !budget.pastHard(),
      rewrite:  async (feedback, previous) => {
        const redo = await withinTurn(anthropic.messages.create({
          model: CHAT_MODEL,
          max_tokens: 4096,
          system: systemBlocks,
          messages: [
            ...messages,
            { role: 'assistant', content: draftAsText(replyBeforeDraftCheck, previous) },
            { role: 'user', content: feedback },
          ],
          tools,
          tool_choice: { type: 'tool', name: RESPONSE_TOOL_NAME },
        }, { signal: turnDeadline.signal }))
        if (!redo) return null
        tokensIn  += redo.usage?.input_tokens  ?? 0
        tokensOut += redo.usage?.output_tokens ?? 0
        const redoUse = redo.content.find(
          (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use' && b.name === RESPONSE_TOOL_NAME,
        )
        return (redoUse?.input as { draft?: unknown } | undefined)?.draft ?? null
      },
    })
    const draft = draftResult.draft
    aiResult = { ...aiResult, response: draftResult.response }

    // Brief 43 PR 14 (Q38): markdown, stray deal tags, em-dashes and "!" out (lib/chat/replyText.ts).
    const cleanResponse = cleanReplyText(aiResult.response ?? '')

    // ── Hydrate the cards Sonnet's tools returned into full rows for the UI ──
    // Only ExtractedOpportunity-backed cards render as `deals`. CRM buyers from
    // search_parties (MojoContact ids) stay in Drift's text; a CRM seller only ever
    // comes back as a seller card from find_seller (Brief 43 PR 5, `sellerCards`).
    const oppCardIds = [...seenCardIds].filter(id => id.length > 0)
    const hydrated = oppCardIds.length > 0
      ? await prisma.extractedOpportunity.findMany({ where: { id: { in: oppCardIds } }, include: oppIncludeForCards })
      : []
    // matchScore: fractional price overlap when the model filtered by budget,
    // else the extraction confidenceScore (unknown-fit fallback, same as before).
    const deals = hydrated
      .map(d => ({
        ...d,
        matchScore: cardOverlap.has(d.id) ? (cardOverlap.get(d.id) ?? 0) : d.confidenceScore,
        streetEasyUrl: getStreetEasyUrl(d.streetEasyId, d.category, d.rawEmail?.bodyContent, d.rawEmail?.attachmentsText),
      }))
      .sort((a, b) => b.matchScore - a.matchScore)

    const storedMsg = files.length > 0
      ? `${userMessage} [📎 ${files.map(f => f.name).join(', ')}]`
      : userMessage

    // Store pendingEvent in assistant message content as JSON so confirm flow can read it.
    // Brief 43 PR 3: a draft is stored the same way (no migration); GET reads it back.
    const pendingEvent = aiResult.pendingEvent ?? null
    const storedAssistantContent = encodeStoredReply({ response: cleanResponse, pendingEvent, draft })

    // Save messages to this session
    await prisma.chatMessage.create({ data: { organizationId, sessionId: session.id, role: 'user', content: storedMsg } })
    await prisma.chatMessage.create({
      data: {
        organizationId,
        sessionId: session.id,
        role: 'assistant', content: storedAssistantContent,
        // Brief 43 PR 5: seller cards ride along in dealsJson (no migration), tagged
        // kind 'crm_seller', so a reopened chat shows the card again; the page
        // splits them back out (components/chat/sellerCardView.ts).
        dealsJson: [...deals, ...sellerCards] as unknown as object[],
        // Brief 27.0 — server-captured report attachments (authoritative), so the
        // chat page can rehydrate a preview card / inline fragment in Phase 1b.
        attachedReport:   (serverAttachedReport ?? undefined) as unknown as object | undefined,
        attachedFragment: (serverAttachedFragment ?? undefined) as unknown as object | undefined,
      },
    })

    // Generate title after the first exchange in a new session (no title yet)
    // Brief 43 PR 4: no title call past the hard deadline (History titles it later).
    if (!session.title && history.length === 0 && !budget.pastHard()) {
      try {
        const openaiForTitle = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
        // The cap also stops the request itself, so a slow title doesn't keep
        // going (and get retried by the SDK) after the reply has gone.
        // Same length as withinTurn's wait below, so the stop comes first.
        const titleCap = deadlineSignal(Math.min(LOOKUP_TIMEOUT_MS, budget.msLeft(TURN_CEILING_MS)))
        const titleCompletion = await withinTurn(openaiForTitle.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'Generate a 4-7 word title that summarizes this real estate conversation. Title case, no punctuation at end, no quotes. Examples: "Brooklyn Buyer ISO Matches", "Coming Soon Under 2M", "Off Market Tribeca Search"' },
            { role: 'user', content: `User asked: ${storedMsg.slice(0, 300)}\nAssistant replied: ${cleanResponse.slice(0, 300)}` },
          ],
          max_tokens: 20,
          temperature: 0.3,
        }, { signal: AbortSignal.any([turnDeadline.signal, titleCap.signal]) }), LOOKUP_TIMEOUT_MS) // a slow title can't hold up a finished reply
          .finally(() => titleCap.clear())
        const title = titleCompletion?.choices[0].message.content?.trim().replace(/^["']|["']$/g, '')
        if (title) await prisma.chatSession.update({ where: { id: session.id }, data: { title } })
      } catch { /* non-fatal */ }
    } else {
      // Touch updatedAt so sessions sort by last activity
      await prisma.chatSession.update({ where: { id: session.id }, data: { updatedAt: new Date() } })
    }

    // ── Brief 2.5 — Drift interaction logging (non-fatal; never breaks chat) ──
    // topCards = the cards actually shown to Ryan (already sorted by matchScore),
    // capped at 20. We await the insert inside try/catch so we can return the
    // interactionId for client-side click/feedback wiring, while any logging
    // failure is swallowed and chat still responds.
    const topCards = deals.slice(0, 20).map((d, idx) => ({
      id:    d.id,
      kind:  d.category,
      title: d.extractedTitle,
      rank:  idx,
      score: d.matchScore,
    }))
    // Brief 3.0: parsedFilters records the tool calls the model actually made
    // (what it searched for + how many matched). Cost is at Sonnet 4.6 pricing.
    const costUsd = (tokensIn / 1_000_000) * CHAT_INPUT_PER_M + (tokensOut / 1_000_000) * CHAT_OUTPUT_PER_M
    let interactionId: string | null = null
    try {
      const interaction = await prisma.driftInteraction.create({
        data: {
          query:          userMessage || storedMsg,
          // Brief 43 PR 3: draftPrivacy records what a draft was flagged for (kinds only, never the text).
          // Brief 43 PR 4: deadline records whether the turn's clock cut anything short.
          parsedFilters:  {
            toolCalls: allToolCalls, maxIterationsHit, guard: guardTelemetry, deadline: { softCut, factCheckSkipped },
            ...(draftResult.outcome !== 'none' ? { draftPrivacy: { outcome: draftResult.outcome, flagKinds: draftResult.flagKinds, rewrote: draftResult.rewrote } } : {}),
          } as unknown as object,
          topCards:       topCards as unknown as object[],
          responseTimeMs: Date.now() - t0,
          modelUsed:      CHAT_MODEL,
          tokensIn,
          tokensOut,
          costUsd,
        },
        select: { id: true },
      })
      interactionId = interaction.id
    } catch (err) {
      console.error('[DealFlow] DriftInteraction logging failed (non-fatal):', err)
    }

    turnDeadline.clear()
    return NextResponse.json({
      sessionId:    session.id,
      interactionId,
      response:     cleanResponse,
      deals,
      seListings:   composed.liveSeListings,
      seFilterUrl:  composed.seFilterUrl,
      // Brief 43 PR 5: the CRM seller card(s) from find_seller ([] when none).
      sellerCards,
      // Brief 27.0 — report attachments (server-captured). null when the turn
      // produced no report/fragment.
      attachedReport:   serverAttachedReport,
      attachedFragment: serverAttachedFragment,
      // Brief 43 PR 3 — the checked draft to copy, or null.
      draft,
    })
  } catch (err) {
    console.error('[DealFlow] Chat API error:', err)
    return NextResponse.json(
      { error: String(err), response: `Server error: ${String(err)}` },
      { status: 500 }
    )
  }
}

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId')
  if (!sessionId) return NextResponse.json({ messages: [] })
  const messages = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  })
  // Brief 43 PR 3: a reply stored as JSON (a draft or a calendar proposal) is
  // shown as its text, with its draft beside it.
  return NextResponse.json({
    messages: messages.map(m => (m.role === 'assistant' ? { ...m, ...replyFields(m.content) } : m)),
  })
}

function replyFields(content: string) {
  const { response, draft } = readStoredReply(content)
  return { content: response, draft }
}
