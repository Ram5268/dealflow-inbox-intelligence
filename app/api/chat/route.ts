export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { runRetrieval } from '@/lib/retrieval'
import { createCalendarEvent } from '@/lib/microsoftCalendar'
import { composeContext } from '@/lib/chat/context/composeContext'
import { getStreetEasyUrl } from '@/lib/chat/streetEasyUrls'
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 60

const SYSTEM_PROMPT = `You are Drift — Ryan Martin's private real estate deal intelligence layer. Ryan is a Douglas Elliman agent working NYC residential real estate across all transaction types.

Your full behavior rules are defined in DEALFLOW_AI.md. Follow them exactly. Key rules summarized here:

DATA AVAILABLE:
- DATABASE: Classified opportunities extracted from Ryan's Outlook inbox emails + StreetEasy hotsheet scraper. This is the ONLY source of listings — there is no external API, no MLS feed, no third-party listings API. Never say "returned by the API" or "from the API". Say "in your database" or "from your inbox" instead.
- MOJO CRM: Ryan's personal NYC seller leads — real property owners he's prospecting. Shown under MOJO SELLER LEADS. Always include name + phone when flagging a Mojo match.
- CALENDAR: Ryan's Outlook schedule (read + propose with confirmation)
- ACRIS: NYC property records (when triggered)
- MORTGAGE RATES: Current rate context (always present)

BUYER ISO RULE: BUYER_ISO and RENTER_INQUIRY are OTHER agents' clients — not Ryan's. When a listing matches a BUYER_ISO, it's a co-brokering opportunity. Always name the source agent and brokerage.

CALENDAR PROTOCOL: When Ryan asks to schedule anything — PROPOSE first, do not create immediately.
Format: I'll create: [title], [Day Date] at [time][, at [location]]. Reply "confirm" to add it to your Outlook.
Only create after receiving "confirm", "yes", "do it", or similar explicit confirmation.

MATCHING: Three tiers — EXACT (all criteria met), CLOSE (off on one: ±1BR, adjacent neighborhood, within 15% price, within 7 days date), STRETCH (off on two). Show ALL results in every tier — no cap. "Available now" is NEVER a date mismatch.

PROPERTY TYPE TERMS: "N-family" means a building with N residential units, NOT N bedrooms. "2-3 family" = a building with 2 or 3 units (typical NYC brownstone/townhouse). A 3BR condo is NEVER a match for a "2-3 family" query. If the user specifies family/unit count and a deal's units field is null or doesn't match, do not present it as an "exact match" — present it as a mismatch or omit.

STRICT NEIGHBORHOOD MATCH (Phase D.5): Retrieval is strict by default. If the user said "in Bed-Stuy" and zero cards came back, that means there are zero active listings in Bed-Stuy (and its variant spellings) matching the other criteria. Do NOT invent results, do NOT pull from adjacent neighborhoods, do NOT recommend listings the retrieval didn't return. Say plainly: "No active listings matching your exact criteria in [neighborhood]. Want me to broaden to nearby areas?" — then if Ryan asks to broaden, he can re-phrase with "near X" or "around X" or "or nearby" and the next turn will include adjacent areas.

RESPONSE FORMAT: Plain text only. No markdown, no bold, no italics, no bullet dashes. One line per listing: [Address] — $[exact price], [beds]BR, [neighborhood]. [key detail]. Available [date]. (exact match)

PRICES: Never round. $9,895 stays $9,895. Copy exactly.
ATTACHMENTS: If 📎 attachment data exists, use it — it's more detailed than the summary.
SUGGESTIONS: Always return exactly 2 specific follow-up questions.
NO FILLER: No "feel free to ask", no "I hope that helps", no "I cannot find" without an alternative.
DEAL CITING: In "referencedDeals", list the exact IDs from [DEAL:id] tags for every deal you mention in your response — this lets us trace which deals you discussed. Cards are shown to the user automatically based on retrieval ranking; this list does NOT gate which cards appear.
STREETEASY LINKS: When a deal's data line contains "SE: https://..." include that URL in your response so Ryan can tap directly to the listing. Never construct or invent a streeteasy.com URL. Only include a StreetEasy URL if it appears verbatim in a [DEAL:] line's SE: field or in the LIVE STREETEASY LISTINGS block. If neither contains a URL for a listing you want to mention, omit the URL entirely.
LIVE STREETEASY RESULTS: When LIVE STREETEASY LISTINGS data is present, lead your response with those results. List each one on its own line: address, price, beds, and the full www.streeteasy.com URL. These are live on-market listings — present them as the primary answer to buyer/renter searches.

Respond with this exact JSON (no markdown, no code fences):
{"response":"your plain text response","suggestions":["specific follow-up 1","specific follow-up 2"],"pendingEvent":null,"referencedDeals":["deal_id_1","deal_id_2"]}`

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

    // ── Single retrieval pipeline (PR 4) ─────────────────────────────────────
    // runRetrieval is wrapped in its own try/catch (returns safe-empty + error field on failure),
    // so this never throws. parsed.* drives all side-channel triggers below.
    const retrievalResult = await runRetrieval(queryText)
    const parsed          = retrievalResult.parsed
    if (retrievalResult.error) {
      console.error('[chat] runRetrieval error (continuing with empty records):', retrievalResult.error)
    } else {
      console.log('[chat] retrieval records:', retrievalResult.records.length, '| durationMs:', retrievalResult.durationMs)
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

    // ── Hydrate full ExtractedOpportunity rows for the cards GPT cites (PR 4) ─
    const oppIncludeForCards = { rawEmail: { select: { receivedDateTime: true, bodyContent: true, attachmentsText: true } } }
    const pipelineDeals = retrievalResult.records.length > 0
      ? await prisma.extractedOpportunity.findMany({
          where:   { id: { in: retrievalResult.records.map(r => r.id) } },
          include: oppIncludeForCards,
        })
      : []

    // Attachment text appendix — dedupe per rawEmailId so we don't bloat context with
    // duplicate broker-blast PDFs across multiple listings from the same email.
    const shownAttachmentFor = new Set<string>()
    const attachmentLines: string[] = []
    for (const o of pipelineDeals) {
      if (!o.rawEmail?.attachmentsText || o.rawEmail.attachmentsText.length === 0) continue
      if (shownAttachmentFor.has(o.rawEmailId)) continue
      shownAttachmentFor.add(o.rawEmailId)
      attachmentLines.push(`[DEAL:${o.id}] 📎 ATTACHMENT: ${o.rawEmail.attachmentsText.slice(0, 5000)}`)
    }
    const attachmentsContext = attachmentLines.length > 0
      ? '\n\nATTACHMENTS (parsed from broker-blast PDFs/docs):\n' + attachmentLines.join('\n\n')
      : ''

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

    const cleanResponse = (aiResult.response ?? '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')   // strip **bold**
      .replace(/\*([^*]+)\*/g, '$1')        // strip *italic*
      .replace(/\s*\[DEAL:[^\]]+\]/g, '')   // strip any stray deal tags from AI text

    // ── Phase D card-count policy ──────────────────────────────────────────
    // POLICY: cards = every record the retrieval pipeline surfaced, sorted by
    // ScoredRecord.score (descending). The LLM's `referencedDeals` array is no
    // longer a gate — it's only kept for traceability (to log which deals the
    // LLM actually discussed). This eliminates non-determinism (same query
    // returning 25 vs 2 cards across sessions) and respects DEALFLOW_AI.md's
    // "show ALL results" rule: if a record matched the user's criteria, the
    // user sees it. The LLM response narrates highlights; the cards present.
    //
    // matchScore reflects retrieval relevance (ScoredRecord.score, 0-100,
    // normalized to 0-1). Falls back to extraction confidenceScore only when
    // the deal isn't in the retrieval pool at all — a real pipeline score of
    // 0 is shown as 0, not silently replaced by classifier confidence.
    const scoreMap = new Map<string, number>(retrievalResult.records.map(r => [r.id, r.score]))
    const deals = pipelineDeals
      .map(d => ({
        ...d,
        matchScore: scoreMap.has(d.id)
          ? (scoreMap.get(d.id) ?? 0) / 100
          : d.confidenceScore,
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
    const usage     = firstCompletion.usage
    const tokensIn  = usage?.input_tokens ?? null
    const tokensOut = usage?.output_tokens ?? null
    // Claude Sonnet 4.6 list pricing: ~$3 / 1M input, ~$15 / 1M output.
    const costUsd = tokensIn != null && tokensOut != null
      ? (tokensIn / 1_000_000) * 3 + (tokensOut / 1_000_000) * 15
      : null
    let interactionId: string | null = null
    try {
      const interaction = await prisma.driftInteraction.create({
        data: {
          query:          userMessage || storedMsg,
          parsedFilters:  parsed ? (parsed as unknown as object) : undefined,
          topCards:       topCards as unknown as object[],
          responseTimeMs: Date.now() - t0,
          modelUsed:      'claude-sonnet-4-6',
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
