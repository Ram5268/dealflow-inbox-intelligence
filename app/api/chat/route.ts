export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { parseQuery } from '@/lib/retrieval/queryParser'
import type { ParsedQuery } from '@/lib/retrieval/types'
import { createCalendarEvent } from '@/lib/microsoftCalendar'
import { graphEnabled } from '@/lib/graphAccess'
import { isMatchingTestModeOnly } from '@/lib/config/matchingTestMode'
import { runCalendarConfirm } from '@/lib/chat/calendarConfirm'
import { composeContext } from '@/lib/chat/context/composeContext'
import { getStreetEasyUrl } from '@/lib/chat/streetEasyUrls'
import { searchListings, type SearchListingsInput } from '@/lib/chat/tools/searchListings'
import { searchParties, type SearchPartiesInput } from '@/lib/chat/tools/searchParties'
import { SEARCH_LISTINGS_TOOL, SEARCH_PARTIES_TOOL, GENERATE_REPORT_TOOL, GENERATE_REPORT_SECTION_TOOL } from '@/lib/chat/tools/schemas'
import { getTemplate } from '@/lib/reports/templates'
import { getGenerator, type SectionResult } from '@/lib/reports/generators'
import { scanForStructuralHallucinations } from '@/lib/chat/guards/regexGuard'
import { verifyResponse, type ToolResultForVerify } from '@/lib/chat/guards/llmVerifier'
import { buildGroundingCorpus, filterToolBoundFlags } from '@/lib/chat/guards/toolBinding'
import { logGuardFireEvent } from '@/lib/chat/guards/instrumentation'
import { buildSystemBlocks, RYAN_MD } from '@/lib/chat/systemBlocks'
import {
  MAX_GUARD_RETRIES,
  selectCannedFallback,
  buildFeedbackPrompt,
  formatFlagLines,
  type GuardAttempt,
  type GuardTelemetry,
} from '@/lib/chat/guards/retry'
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

const SYSTEM_PROMPT = `You are Drift, a real estate deal intelligence assistant for a Douglas Elliman NYC residential broker (Ryan). You have two search tools: search_listings (properties) and search_parties (buyers, renters, and Ryan's Mojo seller/landlord leads).

Voice — how you talk to Ryan:
Speak like Jarvis from Iron Man: warm-formal, dry, understated, anticipatory. You are a trusted operator, not an eager assistant.
- Full sentences and prose by default. If you would reach for an em-dash, use a period or comma instead.
- Acknowledge briefly before delivering ("Certainly." "Right away." "Very good."). Never open with the raw payload.
- No effusive validation. No "great question," no "happy to help," no exclamation points.
- Address Ryan by name sparingly. On greeting, on attention shifts, or after a delivered result. Not every turn.
- End with the natural next question, not a menu of options.
- Understated confidence. Weak leads get named as weak, not cushioned.
- Never narrate your own process. Do not say "let me search" or "I'll pull those up." Just do it and report.
- British-inflected softeners are fine ("If I may," "I'd recommend," "Rather quiet on that front") but do not lean too hard.

Example turns:

User: any coming soon in bedstuy?
You: Three sellers in Bedstuy fit the profile. The strongest is a brownstone on MacDonough with timing that lines up with a spring listing. Shall I walk through it first?

User: yes pull those sellers
You: [call search_parties with the prior turn's filters, then respond] Right away. Two are Mojo leads with phone contact, the third came through a Compass agent last week. Which would you like first?

User: anything in tribeca on the coming-soon side?
You: Nothing in Tribeca at the moment. Rather quiet there this week. Would you like me to widen to SoHo and the West Village?

User: the Franklin lead any good?
You: The Franklin lead is thin. The notes do not give us much to work with. I would set it aside.

NYC knowledge:
Ryan uses NYC industry shorthand: neighborhood nicknames, street-number cutoffs ("below 70th"), price ranges, party roles ("for a buyer", "who's looking for"). Interpret with your own NYC knowledge. If he says "below 70th," you know which Manhattan neighborhoods that includes and excludes. If he says "uptown," you know what that means. Apply that when choosing tool parameters. Pass the specific neighborhoods a phrase implies, not a whole borough.

Behavior:
- Before including a listing or party, verify its address and details actually match ALL constraints Ryan specified. Tool searches may return items that broadly match your filter but violate a specific constraint (e.g., a UWS listing at W 96th St should not be returned for "below 70th" even though UWS was in your neighborhood filter). Read each returned item and exclude any that do not strictly satisfy the stated constraints.
- If the first search returns few results, consider a second search with widened parameters.
- If Ryan asks for "anything that matches" or "close fits," use priceTolerance=0.15 to surface near-misses.
- Never invent listings or parties. Only reference card ids that came from tool results.
- The database contains a mix of seed test data (isTestData=true) and real inbox data. Include both by default. Only exclude test data if Ryan explicitly says "production only" or "real listings only."
- Prices are exact; never round. Mojo leads are Ryan's own seller/landlord prospects; include name and phone when you flag one.
- Extra context (live StreetEasy listings, Mojo, mortgage, calendar, ACRIS, DOB) may appear below. Use it when relevant. If a live StreetEasy block is present, include its verbatim www.streeteasy.com URLs; never invent one.

Affirmative continuations:
When Ryan replies affirmatively to a suggestion you made in your prior turn ("yes", "sure", "pull those", "do it", "ok", "go ahead", "show me"), you MUST re-invoke the appropriate tool this turn with the FULL filter set from the prior turn's context (neighborhoods, price ranges, bed counts, roles, etc.). Never respond conversationally about entities you offered to fetch without actually calling the tool this turn, even if you already mentioned them in your prior message. Every entity you name (prospect, listing, address, phone) must come from a tool output fetched IN THIS TURN.

Reports:
You can generate structured reports with two tools. Use them when Ryan asks for a report or a specific piece of one.
- generate_report(templateId, params) — a FULL report. Use for "draft me a buyer match report for Sarah", "generate a buyer match report". It saves the report and returns a reportId. Currently the only unlocked template is "buyer-match" (id "buyer-match"); its params are { buyerId }.
- generate_report_section(templateId, sectionKey, params) — a SINGLE section, for a quick inline answer. Use for "just the near-misses for Sarah", "budget check on this buyer", "curated matches for the Soho buyer". buyer-match sectionKeys: criteria, matching-inventory, curated-matches, near-misses, off-market, budget-reality, showing-schedule, recommended-adjustment.
Routing: full-request phrasing ("draft me", "generate", "full report") to generate_report; fragment phrasing ("just the", "only the", "what are the", a single named section) to generate_report_section.

Param inference for reports:
- buyerId must be a BUYER_ISO or RENTER_INQUIRY opportunity id. If Ryan names a buyer ("Sarah", "the Soho buyer") but you do not already have an id, call search_parties FIRST to resolve the name to a party, then call the report tool with that id. Infer the buyer from the running conversation when it is clear (a buyer you just discussed, a last-referenced party).
- If it is genuinely ambiguous (e.g. three different Sarahs in recent turns), ask Ryan inline which one — a single plain question. Never offer a menu or list options as suggestions. Only ask when you truly cannot tell.
- If a template is locked or unknown, the tool returns an error; relay it plainly and do not retry.

Presenting reports in your drift_response:
- After generate_report: set attachedReport with the ids from the tool result, and write response EXACTLY in this shape: "Report generated — {templateName} for {subject}. Saved as {reportId}. UI to view coming in Phase 1b." Keep it to that one line plus your normal suggestions.
- After generate_report_section: set attachedFragment, and write response as the section's content in full, readable prose — restate the actual addresses, prices, and reasons from the tool result so Ryan can read the section directly in the chat. Do not invent anything beyond what the tool returned.

Tool structure:
Reply through the drift_response tool: plain text (no markdown, no bullet dashes, no em-dashes), exactly two short follow-up suggestions, and the card ids you referenced. For a scheduling request, propose the event via pendingEvent. For everything else, use your search tools first, then drift_response.`

// Brief 36 — voice mode sends `voice: true`. Appended as its own uncached system
// block after the side-channels, so the cached prefix, the guard's grounding
// corpus and the stored messages are unchanged.
const VOICE_INSTRUCTION = "You're speaking aloud. Answer in one to three short conversational paragraphs; no tables, bullet lists or headings; a short lead-in phrase ending in a colon is fine; offer to go deeper."

// Trim a search-tool card down to the fact-bearing fields the guard verifier
// needs to ground Sonnet's response. Drops scoring/UI noise; keeps anything a
// claim could reference (address, price, beds, category, neighborhood, and for
// parties name/phone/title).
function trimCardForGuard(card: Record<string, unknown>): Record<string, unknown> {
  const keep = ['id', 'category', 'title', 'address', 'neighborhood', 'beds', 'price', 'priceRange', 'name', 'phone', 'role'] as const
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
  const t0 = Date.now()
  try {
    const body = await req.json()
    const userMessage: string = (body.message ?? '').trim()
    const files: FileData[] = body.files ?? []

    if (!userMessage && files.length === 0) {
      return NextResponse.json({ error: 'Message or file required' }, { status: 400 })
    }

    const organizationId = await getCurrentOrgId()

    // Resolve or create session
    const sessionId: string | undefined = body.sessionId
    let session = sessionId
      ? await prisma.chatSession.findUnique({ where: { id: sessionId } })
      : null
    if (!session) {
      session = await prisma.chatSession.create({ data: { organizationId } })
    }

    // Load conversation history for this session only
    const history = await prisma.chatMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'asc' },
      take: 30,
    })

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
    const isConfirmMessage = lastPendingEvent != null
      && /\bconfirm\b|\byes\b|\bdo it\b|\blooks good\b|\bgo ahead\b|\badd it\b/.test(queryText)

    // ── Calendar confirm fast-path: create the pending event directly, skip LLM + all context fetches ──
    // Brief 8.0-lite Fix #2 — the actual write + audit + guard moved into
    // runCalendarConfirm (injectable, unit-tested). The two-step gate (regex +
    // lastPendingEvent) stays inline above; only the side effects moved.
    if (isConfirmMessage && lastPendingEvent) {
      try {
        const result = await runCalendarConfirm({
          organizationId,
          sessionId: session.id,
          userMessage,
          pendingEvent: {
            subject:  lastPendingEvent.subject,
            startISO: lastPendingEvent.startISO,
            endISO:   lastPendingEvent.endISO,
            location: lastPendingEvent.location,
            notes:    lastPendingEvent.notes,
          },
          deps: {
            graphOn:        graphEnabled(),
            testModeOn:     isMatchingTestModeOnly(),
            createEvent:    createCalendarEvent,
            createMessage:  (data) => prisma.chatMessage.create({ data: data as never }),
            createAuditLog: (data) => prisma.auditLog.create({ data: data as never }),
            touchSession:   (id) => prisma.chatSession.update({ where: { id }, data: { updatedAt: new Date() } }),
          },
        })
        return NextResponse.json({ sessionId: session.id, response: result.text, deals: [], suggestions: [] })
      } catch (err) {
        // Fall through to normal AI if creation fails
        console.error('[DealFlow] Calendar confirm error:', err)
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
            description: 'Plain text response. No markdown, no bold, no italics, no bullet dashes, no em-dashes.',
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
        },
        required: ['response', 'suggestions', 'referencedDeals'],
      } as Anthropic.Messages.Tool.InputSchema,
    }

    const anthropicHistory: Anthropic.Messages.MessageParam[] = history.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }))

    // ── Sonnet 4.6 tool_use loop ─────────────────────────────────────────────
    // tool_choice='any' forces a tool call every turn, so the loop deterministically
    // terminates on drift_response (Sonnet's structured final reply) rather than a
    // free-text end_turn. This preserves suggestions + calendar pendingEvent.
    type AttachedReport = { reportId: string; templateId: string; templateName: string; subject: string; sectionCount: number; matchCount?: number }
    type AttachedFragment = { templateId: string; sectionKey: string; title: string; content: SectionResult['content']; sources: SectionResult['sources'] }
    type AiResult = { response: string; suggestions: string[]; pendingEvent?: Record<string, string> | null; referencedDeals?: string[]; attachedReport?: AttachedReport; attachedFragment?: AttachedFragment }
    const tools: Anthropic.Messages.Tool[] = [SEARCH_LISTINGS_TOOL, SEARCH_PARTIES_TOOL, GENERATE_REPORT_TOOL, GENERATE_REPORT_SECTION_TOOL, responseTool]
    // Brief 27.0 — server-authoritative capture of the report/fragment produced
    // this turn. We persist + return THESE (not whatever Sonnet echoes) so ids
    // are always correct and the attachment survives guard rewrites.
    let serverAttachedReport: AttachedReport | null = null
    let serverAttachedFragment: AttachedFragment | null = null
    // session is non-null here; capture the id so the report-tool closure below
    // doesn't re-widen it to nullable.
    const activeSessionId = session.id
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
        const report = await prisma.report.create({
          data: {
            templateId,
            params: params as object,
            sections: generated.sections as unknown as object,
            markdown: generated.markdown,
            sources: generated.sources as unknown as object,
            sessionId: activeSessionId,
            buyerId,
          },
          select: { id: true },
        })
        serverAttachedReport = {
          reportId: report.id, templateId, templateName: template.name,
          subject: generated.subject, sectionCount: generated.sections.length, matchCount: generated.matchCount,
        }
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

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      const completion = await anthropic.messages.create({
        model: CHAT_MODEL,
        max_tokens: 4096,
        system: systemBlocks,
        messages,
        tools,
        tool_choice: { type: 'any' },
      })
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
          (b.name === 'search_listings' || b.name === 'search_parties' || REPORT_TOOL_NAMES.has(b.name)),
      )
      if (toolUses.length === 0) break  // shouldn't happen under tool_choice='any'

      messages.push({ role: 'assistant', content: completion.content })
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = await Promise.all(
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
            },
          })
          for (const c of output.cards) {
            if (!seenCardIds.has(c.id)) seenCardIds.add(c.id)
            if (c.priceOverlapScore !== undefined && !cardOverlap.has(c.id)) cardOverlap.set(c.id, c.priceOverlapScore)
          }
          return { type: 'tool_result' as const, tool_use_id: tu.id, content: JSON.stringify(output) }
        }),
      )
      messages.push({ role: 'user', content: toolResults })

      if (iter === MAX_ITERATIONS - 1) maxIterationsHit = true
    }

    // Force a final structured reply if the loop exhausted its budget without one.
    if (!aiResult) {
      console.warn('[chat] MAX_ITERATIONS reached without drift_response — forcing final reply')
      maxIterationsHit = true
      const forced = await anthropic.messages.create({
        model: CHAT_MODEL,
        max_tokens: 4096,
        system: systemBlocks,
        messages,
        tools: [responseTool],
        tool_choice: { type: 'tool', name: RESPONSE_TOOL_NAME },
      })
      tokensIn  += forced.usage?.input_tokens  ?? 0
      tokensOut += forced.usage?.output_tokens ?? 0
      const forcedUse = forced.content.find(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use' && b.name === RESPONSE_TOOL_NAME,
      )
      aiResult = (forcedUse?.input as AiResult) ?? { response: 'Sorry, I had trouble pulling that together. Try rephrasing?', suggestions: [], referencedDeals: [] }
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
    const guardEnabled = process.env.HALLUCINATION_GUARD_ENABLED !== 'false'
    const guardApplies = guardEnabled && !aiResult.pendingEvent
    let currentResponse = aiResult.response ?? ''
    // Brief 11.0 Fix #2 — the first thing Sonnet tried to say, before any guard
    // correction/fallback overwrites currentResponse. Logged for guard-fire audit.
    const assistantAttempt = currentResponse
    const guardHistory: GuardAttempt[] = []
    let fellbackToCanned = false
    let guardFinalAttempt = 0
    let latestSuggestions: string[] | undefined
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
          scanForStructuralHallucinations(currentResponse),
          groundingCorpus,
        )
        const verifier = await verifyResponse(userMessage || queryText, toolResultsForGuard, sideChannelText, currentResponse)
        guardHistory.push({ attempt, regexFlags, verifierFlags: verifier.flags, verifierCost: verifier.costUsd })
        if (regexFlags.length === 0 && verifier.isGrounded) break

        attempt++
        if (attempt > MAX_GUARD_RETRIES) {
          // Contextual fallback — pick the variant matching what the final
          // attempt actually flagged (public-records vs finance vs
          // self-description vs generic) instead of always assuming records.
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
          { role: 'assistant', content: currentResponse },
          { role: 'user', content: buildFeedbackPrompt(flagLines) },
        ]
        const retry = await anthropic.messages.create({
          model: CHAT_MODEL,
          max_tokens: 4096,
          system: systemBlocks,
          messages: retryMessages,
          tools,
          tool_choice: { type: 'tool', name: RESPONSE_TOOL_NAME },
        })
        tokensIn  += retry.usage?.input_tokens  ?? 0
        tokensOut += retry.usage?.output_tokens ?? 0
        const retryUse = retry.content.find(
          (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use' && b.name === RESPONSE_TOOL_NAME,
        )
        const retryResult = retryUse?.input as AiResult | undefined
        if (retryResult) {
          currentResponse   = retryResult.response ?? currentResponse
          latestSuggestions = retryResult.suggestions ?? latestSuggestions
          latestReferenced  = retryResult.referencedDeals ?? latestReferenced
        }
      }
      guardFinalAttempt = attempt
    }

    // Fold the guard's final text (corrected / canned / unchanged) back into aiResult.
    aiResult = {
      ...aiResult,
      response:        currentResponse,
      suggestions:     latestSuggestions ?? aiResult.suggestions,
      referencedDeals: latestReferenced ?? aiResult.referencedDeals,
    }

    const guardTelemetry: GuardTelemetry = {
      enabled:              guardEnabled,
      finalAttempt:         guardFinalAttempt,
      fellbackToCanned,
      history:              guardHistory,
      totalVerifierCostUsd: guardHistory.reduce((a, h) => a + h.verifierCost, 0),
    }

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

    const cleanResponse = (aiResult.response ?? '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')   // strip **bold**
      .replace(/\*([^*]+)\*/g, '$1')        // strip *italic*
      .replace(/\s*\[DEAL:[^\]]+\]/g, '')   // strip any stray deal tags from AI text

    // ── Hydrate the cards Sonnet's tools returned into full rows for the UI ──
    // Only ExtractedOpportunity-backed cards render as `deals`; Mojo CRM leads
    // (MOJO_LEAD ids belong to MojoContact) surface in Sonnet's text (name+phone),
    // matching the prior pipeline where Mojo was context, not a card.
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

    // Store pendingEvent in assistant message content as JSON so confirm flow can read it
    const pendingEvent = aiResult.pendingEvent ?? null
    const storedAssistantContent = pendingEvent
      ? JSON.stringify({ response: cleanResponse, suggestions: aiResult.suggestions ?? [], pendingEvent })
      : cleanResponse

    // Save messages to this session
    await prisma.chatMessage.create({ data: { organizationId, sessionId: session.id, role: 'user', content: storedMsg } })
    await prisma.chatMessage.create({
      data: {
        organizationId,
        sessionId: session.id,
        role: 'assistant', content: storedAssistantContent,
        dealsJson: deals as unknown as object[],
        suggestions: (aiResult.suggestions ?? []) as unknown as string[],
        // Brief 27.0 — server-captured report attachments (authoritative), so the
        // chat page can rehydrate a preview card / inline fragment in Phase 1b.
        attachedReport:   (serverAttachedReport ?? undefined) as unknown as object | undefined,
        attachedFragment: (serverAttachedFragment ?? undefined) as unknown as object | undefined,
      },
    })

    // Generate title after the first exchange in a new session (no title yet)
    if (!session.title && history.length === 0) {
      try {
        const openaiForTitle = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
        const titleCompletion = await openaiForTitle.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'Generate a 4-7 word title that summarizes this real estate conversation. Title case, no punctuation at end, no quotes. Examples: "Brooklyn Buyer ISO Matches", "Coming Soon Under 2M", "Off Market Tribeca Search"' },
            { role: 'user', content: `User asked: ${storedMsg.slice(0, 300)}\nAssistant replied: ${cleanResponse.slice(0, 300)}` },
          ],
          max_tokens: 20,
          temperature: 0.3,
        })
        const title = titleCompletion.choices[0].message.content?.trim().replace(/^["']|["']$/g, '')
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
          parsedFilters:  { toolCalls: allToolCalls, maxIterationsHit, guard: guardTelemetry } as unknown as object,
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

    return NextResponse.json({
      sessionId:    session.id,
      interactionId,
      response:     cleanResponse,
      deals,
      suggestions:  aiResult.suggestions ?? [],
      seListings:   composed.liveSeListings,
      seFilterUrl:  composed.seFilterUrl,
      // Brief 27.0 — report attachments (server-captured). null when the turn
      // produced no report/fragment.
      attachedReport:   serverAttachedReport,
      attachedFragment: serverAttachedFragment,
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
  return NextResponse.json({ messages })
}
