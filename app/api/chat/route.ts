export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { parseQuery } from '@/lib/retrieval/queryParser'
import type { ParsedQuery } from '@/lib/retrieval/types'
import { createCalendarEvent } from '@/lib/microsoftCalendar'
import { composeContext } from '@/lib/chat/context/composeContext'
import { getStreetEasyUrl } from '@/lib/chat/streetEasyUrls'
import { searchListings, type SearchListingsInput } from '@/lib/chat/tools/searchListings'
import { searchParties, type SearchPartiesInput } from '@/lib/chat/tools/searchParties'
import { SEARCH_LISTINGS_TOOL, SEARCH_PARTIES_TOOL } from '@/lib/chat/tools/schemas'
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'

// Brief 3.0 — chat runs on Haiku 4.5 (cheaper sibling of Sonnet, knows NYC
// natively). Extraction/classifier are unchanged elsewhere.
const CHAT_MODEL = 'claude-haiku-4-5-20251001'
// Haiku 4.5 list pricing: $1 / 1M input, $5 / 1M output.
const HAIKU_INPUT_PER_M = 1
const HAIKU_OUTPUT_PER_M = 5
// Safety cap on the tool_use loop — if Haiku hasn't finished after this many
// search rounds it's spinning; we force a final structured reply.
const MAX_ITERATIONS = 6

export const maxDuration = 60

const SYSTEM_PROMPT = `You are Drift — Ryan Martin's private real estate deal intelligence assistant. Ryan is a Douglas Elliman agent working NYC residential real estate across all transaction types.

TOOLS — you read Ryan's English directly and decide what to search for; you may search more than once:
- search_listings: property inventory (sale + rental). Use for "what's available", buyer/renter searches, deals, inventory.
- search_parties: the demand + lead side — OTHER agents' buyers/renters (co-broke) and Ryan's Mojo CRM seller/landlord leads.
- drift_response: your FINAL structured reply. Call it exactly once, ALONE, after you have gathered what you need. Never call it in the same turn as a search.
Workflow: search first, review the results, then respond. If the first search returns fewer than ~5 results and the ask was broad, widen ONCE (raise priceTolerance to ~0.15, or drop the tightest filter) and say in your reply that you widened. For "show me everything" queries use a high limit (up to 200) or iterate, and state the total count.

NYC BROKER CONVENTIONS (critical — apply these when choosing tool arguments):
- "Below 70th street" or ANY numbered-street reference → borough="Manhattan" unless another borough is named (Brooklyn, Queens, Bronx, Staten Island).
- "Uptown" = above 59th St Manhattan; "Midtown" = 34th–59th; "Downtown" = below 34th.
- Shorthand: UWS=Upper West Side, UES=Upper East Side, LES=Lower East Side, FiDi=Financial District, DUMBO=Brooklyn.
- "for a buyer" / "for a client" → search listings. "who's looking for…" → search parties.
- Budget: "under $X" / "up to $X" → priceMax=X. "around $X" → priceMin=X*0.9, priceMax=X*1.1.
- Studio = beds 0.

DATA: listings and parties come from your tool calls. Extra context may appear below the rules (live StreetEasy listings, Mojo seller leads, mortgage rates, calendar, ACRIS, DOB) — use it when relevant. There is no external MLS/API: say "in your database" or "from your inbox", never "from the API".

BUYER ISO RULE: BUYER_ISO and RENTER_INQUIRY are OTHER agents' clients — co-brokering opportunities. Name the source agent/brokerage when known.
MOJO: Mojo leads are Ryan's own seller/landlord prospects — always include name + phone when you flag one.

CALENDAR PROTOCOL: When Ryan asks to schedule anything — PROPOSE first via pendingEvent, do not create.
Format the proposal text: I'll create: [title], [Day Date] at [time][, at [location]]. Reply "confirm" to add it to your Outlook.
Actual creation happens only after he confirms (handled outside this turn).

RESPONSE (returned via the drift_response tool):
- Plain text only. No markdown, no bold, no italics, no bullet dashes. One line per listing: [Address] — $[exact price], [beds]BR, [neighborhood]. [key detail]. (match quality)
- PRICES exact — never round. $9,895 stays $9,895.
- Lead with the strongest fits. State the count ("I found 12 matches, top 5 shown"). If a search hit its limit, say more exist.
- Be terse. Brokers are busy. Skip preamble and process narration.
- Never invent a listing or party. Every id you cite must come from a tool result.
- Seed/test rows are excluded by default; only set includeTestData=true if Ryan explicitly says "test" or "seed" data.
- STREETEASY: if a LIVE STREETEASY LISTINGS block is present, lead with it and include the verbatim www.streeteasy.com URLs. Never construct or invent a StreetEasy URL.
- suggestions: exactly 2 specific follow-up questions.
- referencedDeals: the exact ids you mentioned (traceability only — cards are shown to Ryan from the tool results regardless).`

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
    const conversationHistory = history.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }))

    // Normalize query text used for retrieval + side-channel triggers
    const queryText = (userMessage || files.map(f => f.name).join(' ')).toLowerCase().trim()

    // ── Brief 3.0: lightweight parse drives the side-channels only ───────────
    // The lossy parseQuery → rigid-SQL → 25-cap card retrieval (runRetrieval) is
    // gone; Haiku's search_listings / search_parties tools now find the cards.
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
    if (isConfirmMessage && lastPendingEvent) {
      try {
        const endISO = lastPendingEvent.endISO || (() => {
          const d = new Date(lastPendingEvent.startISO)
          d.setMinutes(d.getMinutes() + 30)
          return d.toISOString()
        })()
        await createCalendarEvent({
          subject:  lastPendingEvent.subject,
          startISO: lastPendingEvent.startISO,
          endISO,
          location: lastPendingEvent.location,
          notes:    lastPendingEvent.notes,
        })
        const confirmText = `Done — added to your Outlook: ${lastPendingEvent.subject} on ${new Date(lastPendingEvent.startISO).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} at ${new Date(lastPendingEvent.startISO).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}.`
        const storedUser = userMessage
        await prisma.chatMessage.create({ data: { organizationId, sessionId: session.id, role: 'user', content: storedUser } })
        await prisma.chatMessage.create({ data: { organizationId, sessionId: session.id, role: 'assistant', content: confirmText, dealsJson: [], suggestions: [] } })
        await prisma.chatSession.update({ where: { id: session.id }, data: { updatedAt: new Date() } })
        return NextResponse.json({ sessionId: session.id, response: confirmText, deals: [], suggestions: [] })
      } catch (err) {
        // Fall through to normal AI if creation fails
        console.error('[DealFlow] Calendar confirm error:', err)
      }
    }

    // ── Compose all 7 side-channel context blocks in parallel (PR 5) ─────────
    // Mortgage, ACRIS, DOB, calendar, matches, liveStreetEasy, mojo.
    // Each fetcher has its own try/catch; per-fetcher failures are isolated.
    // DEPRECATED: body.showMatches was the chat-based path for the home
    // "Review matches" link before /matches replaced it. No UI surface
    // sends this flag anymore. Left for API consumers; remove once
    // confirmed no external caller relies on it.
    const composed = await composeContext({
      parsed,
      userMessage,
      queryText,
      isConfirmMessage,
      showMatches: body.showMatches === true,
    })

    // Cards are hydrated AFTER the tool_use loop (from the ids Haiku's tools
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

    // ── System prompt: static SYSTEM_PROMPT cached; dynamic side-channel block uncached ──
    // The dynamic block carries composeContext's side-channels (live StreetEasy,
    // Mojo, mortgage, calendar, ACRIS, DOB). Cards are NOT injected here anymore
    // — Haiku pulls them via the search tools.
    const dynamicSystemBlock = [composed.pre, composed.post].filter(Boolean).join('\n\n').trim()
    const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ]
    if (dynamicSystemBlock) systemBlocks.push({ type: 'text', text: dynamicSystemBlock })

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
            description: 'Exact card ids you mentioned (e.g. SEED_SALE_06). Traceability only — does not gate which cards Ryan sees.',
          },
        },
        required: ['response', 'suggestions', 'referencedDeals'],
      } as Anthropic.Messages.Tool.InputSchema,
    }

    const anthropicHistory: Anthropic.Messages.MessageParam[] = conversationHistory.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }))

    // ── Haiku 4.5 tool_use loop ─────────────────────────────────────────────
    // tool_choice='any' forces a tool call every turn, so the loop deterministically
    // terminates on drift_response (Haiku's structured final reply) rather than a
    // free-text end_turn — this preserves suggestions + calendar pendingEvent.
    type AiResult = { response: string; suggestions: string[]; pendingEvent?: Record<string, string> | null; referencedDeals?: string[] }
    const tools: Anthropic.Messages.Tool[] = [SEARCH_LISTINGS_TOOL, SEARCH_PARTIES_TOOL, responseTool]
    const messages: Anthropic.Messages.MessageParam[] = [
      ...anthropicHistory,
      { role: 'user', content: userBlocks },
    ]
    // Every card Haiku saw across all tool calls, deduped by id (order preserved).
    const allToolCalls: Array<{ name: string; input: unknown; totalMatched: number; cardIds: string[] }> = []
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

      const searchUses = completion.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock =>
          b.type === 'tool_use' && (b.name === 'search_listings' || b.name === 'search_parties'),
      )
      if (searchUses.length === 0) break  // shouldn't happen under tool_choice='any'

      messages.push({ role: 'assistant', content: completion.content })
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = await Promise.all(
        searchUses.map(async (tu) => {
          let output: { cards: Array<{ id: string; priceOverlapScore?: number }>; totalMatched: number }
          try {
            output = await runSearchTool(tu.name, tu.input)
          } catch (e) {
            console.error(`[chat] tool ${tu.name} failed:`, e)
            return { type: 'tool_result' as const, tool_use_id: tu.id, content: JSON.stringify({ error: String(e) }), is_error: true }
          }
          allToolCalls.push({ name: tu.name, input: tu.input, totalMatched: output.totalMatched, cardIds: output.cards.map(c => c.id) })
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

    const cleanResponse = (aiResult.response ?? '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')   // strip **bold**
      .replace(/\*([^*]+)\*/g, '$1')        // strip *italic*
      .replace(/\s*\[DEAL:[^\]]+\]/g, '')   // strip any stray deal tags from AI text

    // ── Hydrate the cards Haiku's tools returned into full rows for the UI ──
    // Only ExtractedOpportunity-backed cards render as `deals`; Mojo CRM leads
    // (MOJO_LEAD ids belong to MojoContact) surface in Haiku's text (name+phone),
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
    // Brief 3.0: parsedFilters now records the tool calls Haiku actually made
    // (what it searched for + how many matched), and cost is at Haiku pricing.
    const costUsd = (tokensIn / 1_000_000) * HAIKU_INPUT_PER_M + (tokensOut / 1_000_000) * HAIKU_OUTPUT_PER_M
    let interactionId: string | null = null
    try {
      const interaction = await prisma.driftInteraction.create({
        data: {
          query:          userMessage || storedMsg,
          parsedFilters:  { toolCalls: allToolCalls, maxIterationsHit } as unknown as object,
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
