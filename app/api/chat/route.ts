import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { semanticSearch, embedText } from '@/lib/embeddings'
import { getCurrentMortgageRate, formatRateContext, estimateMonthlyPayment } from '@/lib/mortgageRates'
import { lookupProperty, formatForChat, extractAddressFromText } from '@/lib/acris'
import OpenAI from 'openai'

export const maxDuration = 60

const SYSTEM_PROMPT = `You are DealFlow — Ryan Martin's private deal intelligence layer. Ryan is a Douglas Elliman agent working NYC residential real estate: sales, rentals, buyers, sellers, landlords, new dev.

Your database contains opportunities extracted from Ryan's inbox: coming soon, off-market, active listings, price drops, buyer ISOs from other agents, renter inquiries, seller leads, landlord leads, open houses, new development inventory, and full attachment data from listing PDFs and flyers.

BUYER ISO CONTEXT:
BUYER_ISO and RENTER_INQUIRY records are NOT Ryan's own clients — they are other agents' buyers/renters broadcasting their needs. When a listing matches a BUYER_ISO, that's a co-brokering opportunity: Ryan has the listing, the other agent has the buyer. Always name the source agent and brokerage when flagging these matches.

CORE JOB:
- Surface the right deals fast. Lead with the most actionable info.
- Proactively match: listing vs buyer ISO, rental vs renter inquiry, seller lead vs buyer need.
- When Ryan describes a client need, scan for matches and rank them — exact first, then close, then adjacent.
- Never end with "nothing found." If no exact match exists, always offer the closest alternatives with one sentence explaining why they might still work.

MATCHING LOGIC — always think in three tiers:
1. EXACT MATCH: Meets all stated criteria (neighborhood, size, price, date). Lead with these.
2. CLOSE MATCH: Off on one criterion. Flag what's different and why it might still work.
   - Date: ±7 days of requested move-in = close. "Available now" = flexible move-in, almost always negotiable.
   - Size: ±1 bedroom = close if price range overlaps.
   - Neighborhood: adjacent neighborhood = close (see adjacency list below).
   - Price: within 15% = close.
3. STRETCH: Off on two criteria but has a compelling reason (rare amenity, great price, etc.). Max 1 stretch suggestion.

NYC NEIGHBORHOOD ADJACENCY (if nothing in requested area, check these automatically):
- UES ↔ Yorkville, Carnegie Hill, Lenox Hill, East Harlem
- UWS ↔ Morningside Heights, Manhattan Valley, Lincoln Square
- Midtown ↔ Murray Hill, Kips Bay, Hell's Kitchen, Chelsea, Gramercy
- Chelsea ↔ West Village, Flatiron, Hell's Kitchen
- Tribeca ↔ Soho, Financial District, Two Bridges
- Williamsburg ↔ Greenpoint, Bushwick, Bed-Stuy
- Park Slope ↔ Carroll Gardens, Cobble Hill, Prospect Heights, Gowanus
- LIC ↔ Astoria, Sunnyside, Woodside
- Little Neck ↔ Douglaston, Great Neck (Nassau), Bayside, Oakland Gardens
- Forest Hills ↔ Rego Park, Kew Gardens, Jamaica Estates
- Jackson Heights ↔ Elmhurst, Woodside, Corona

DATE LOGIC FOR RENTALS:
- "Available now" or "immediate" = tenant can negotiate move-in date → treat as flexible, mention it
- Exact date match (e.g., June 4) = flag as exact
- Within 7 days of requested date = close match, mention the delta
- 8–21 days off = mention as a stretch with caveat
- 30+ days off = only mention if nothing closer exists

NYC REAL ESTATE KNOWLEDGE:
- Understand NYC-specific context: no-fee vs fee, net effective vs gross rent, co-op vs condo vs condop, sponsor units, REBNY, StreetEasy, OLR, RLS, exclusives.
- Understand deal mechanics: commission splits, co-broking, dual agency, referral fees.
- Know price ranges by neighborhood and unit type — call out if something is priced well or off.

RESPONSE STYLE:
- Be direct and brief. Ryan is busy. No filler, no "feel free to ask", no "I hope that helps".
- Lead with exact matches. Then close matches labeled "(close match — [what's different])".
- For listings: address → price → size → key detail → availability. One line each.
- For matches: state the match clearly, one sentence on why it works or what to watch.
- Never say "I cannot find" without immediately offering alternatives.

DATA RULES:
- Only reference deals in the database. Never invent addresses, prices, or agents.
- When the same property appears in multiple emails, use the MOST RECENT version.
- If attachment data is available (📎), use it — it's more detailed than the summary.
- Reference deals with [DEAL:id] markers.

IMAGES AND FILES:
- You can see any image or file Ryan shares. Read and extract everything visible.
- For email screenshots: read the full content, then check if it matches a database deal.
- For listing flyers/PDFs: extract all addresses, prices, beds, baths, availability.
- Never say you cannot see an image.

Respond with this exact JSON (no markdown, no code fences):
{"response":"your response text","suggestions":["q1","q2"]}`

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
  try {
    const body = await req.json()
    const userMessage: string = (body.message ?? '').trim()
    const files: FileData[] = body.files ?? []

    if (!userMessage && files.length === 0) {
      return NextResponse.json({ error: 'Message or file required' }, { status: 400 })
    }

    // Resolve or create session
    const sessionId: string | undefined = body.sessionId
    let session = sessionId
      ? await prisma.chatSession.findUnique({ where: { id: sessionId } })
      : null
    if (!session) {
      session = await prisma.chatSession.create({ data: {} })
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

    // Semantic search: find most relevant deals for this query
    // Fall back to recent-first if no embeddings exist yet
    let opportunityIds: string[] | null = null
    try {
      const queryText = userMessage || files.map(f => f.name).join(' ')
      if (queryText.trim()) {
        opportunityIds = await semanticSearch(queryText, 40)
      }
    } catch {
      // No embeddings yet — fall back to recency
    }

    const opportunities = opportunityIds && opportunityIds.length > 0
      ? await prisma.extractedOpportunity.findMany({
          where: { id: { in: opportunityIds }, isDuplicate: false },
          include: { rawEmail: { select: { receivedDateTime: true, bodyContent: true, attachmentsText: true } } },
        })
      : await prisma.extractedOpportunity.findMany({
          where: { isDuplicate: false },
          orderBy: { createdAt: 'desc' },
          take: 40,
          include: { rawEmail: { select: { receivedDateTime: true, bodyContent: true, attachmentsText: true } } },
        })
    // Track which rawEmailIds have already had their attachment text shown —
    // multiple opportunities from the same email share identical attachment text,
    // so we only include it once to avoid inflating the context window.
    const shownAttachmentFor = new Set<string>()

    const dbContext = opportunities.length === 0
      ? 'Database is empty — run a sync first.'
      : `DATABASE (${opportunities.length} opportunities):\n` + opportunities.map(o => {
          const emailDate = o.rawEmail?.receivedDateTime
            ? new Date(o.rawEmail.receivedDateTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : null
          const hasAttText = o.rawEmail?.attachmentsText && o.rawEmail.attachmentsText.length > 0
          const showAtt = hasAttText && !shownAttachmentFor.has(o.rawEmailId)
          if (showAtt) shownAttachmentFor.add(o.rawEmailId)
          const attachSnippet = showAtt
            ? `\n  📎 ATTACHMENT (email dated ${emailDate}): ${o.rawEmail!.attachmentsText!.slice(0, 5000)}`
            : ''
          const bodySnippet = o.rawEmail?.bodyContent && !hasAttText
            ? `\n  BODY: ${o.rawEmail.bodyContent.slice(0, 800)}`
            : ''
          const dateTag = emailDate ? ` | received ${emailDate}` : ''
          return `[DEAL:${o.id}] ${o.extractedTitle} | ${o.category} | ${o.neighborhood ?? ''}${o.borough ? ', ' + o.borough : ''} | ${o.price ? '$' + o.price.toLocaleString() : o.maxPrice ? 'up to $' + o.maxPrice.toLocaleString() : 'no price'} | ${o.propertyType ?? ''} | ${o.beds ? o.beds + 'BR' : ''} ${o.units ? o.units + ' units' : ''} | ${o.sourceBrokerage ?? ''} | ${Math.round(o.confidenceScore * 100)}%${dateTag} | ${o.extractedSummary}${attachSnippet}${bodySnippet}`
        }).join('\n')

    // Process files into text chunks and image parts
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

    // Build OpenAI messages
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const hasImages = imageParts.length > 0
    const userContent: Part[] | string = hasImages
      ? [{ type: 'text', text: textContent }, ...imageParts]
      : textContent

    // ACRIS property lookup — triggered when the message asks about ownership,
    // sale history, or property records and contains a street address
    const ACRIS_KEYWORDS = ['who owns', 'owns', 'ownership', 'acris', 'property record',
      'sold for', 'last sale', 'sale price', 'what did', 'purchase price',
      'deed', 'look up', 'lien', 'mortgage on', 'bought', 'bought for', 'paid for']
    const messageLower = userMessage.toLowerCase()
    const acrisTrigger = ACRIS_KEYWORDS.some(k => messageLower.includes(k))
    let acrisContext = ''
    if (acrisTrigger) {
      const detectedAddress = extractAddressFromText(userMessage)
      if (detectedAddress) {
        try {
          const acrisData = await lookupProperty(detectedAddress)
          if (acrisData) acrisContext = `\n\n${formatForChat(acrisData)}`
        } catch { /* non-fatal */ }
      }
    }

    // Fetch current mortgage rate for market context
    const mortgageRate = await getCurrentMortgageRate()
    const rateContext = mortgageRate
      ? `\nMARKET RATE: ${formatRateContext(mortgageRate)}\nAt ${mortgageRate.rate}%: $500K loan = $${estimateMonthlyPayment(500000, mortgageRate.rate).toLocaleString()}/mo | $1M = $${estimateMonthlyPayment(1000000, mortgageRate.rate).toLocaleString()}/mo | $2M = $${estimateMonthlyPayment(2000000, mortgageRate.rate).toLocaleString()}/mo`
      : ''

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: `${SYSTEM_PROMPT}${rateContext}${acrisContext}\n\n${dbContext}` },
      ...conversationHistory.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content: userContent },
    ]

    const completion = await client.chat.completions.create({
      model: 'gpt-4o',
      messages,
      temperature: 0.2,
      max_tokens: 1500,
      // Never use response_format: json_object with vision — it causes failures
    })

    const raw = (completion.choices[0].message.content ?? '').trim()
    console.log('[DealFlow] Raw AI response:', raw.slice(0, 200))

    // Parse JSON robustly
    let aiResult: { response: string; suggestions: string[] }
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

    const ids = (aiResult.response ?? '').match(/\[DEAL:([^\]]+)\]/g)?.map(m => m.replace(/\[DEAL:|]/g, '')) ?? []
    const cleanResponse = (aiResult.response ?? '').replace(/\s*\[DEAL:[^\]]+\]/g, '')
    const deals = ids.length > 0 ? await prisma.extractedOpportunity.findMany({ where: { id: { in: ids } } }) : []

    const storedMsg = files.length > 0
      ? `${userMessage} [📎 ${files.map(f => f.name).join(', ')}]`
      : userMessage

    // Save messages to this session
    await prisma.chatMessage.create({ data: { sessionId: session.id, role: 'user', content: storedMsg } })
    await prisma.chatMessage.create({
      data: {
        sessionId: session.id,
        role: 'assistant', content: cleanResponse,
        dealsJson: deals as unknown as object[],
        suggestions: (aiResult.suggestions ?? []) as unknown as string[],
      },
    })

    // Generate title after the first exchange in a new session (no title yet)
    if (!session.title && history.length === 0) {
      try {
        const titleCompletion = await client.chat.completions.create({
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

    return NextResponse.json({ sessionId: session.id, response: cleanResponse, deals, suggestions: aiResult.suggestions ?? [] })
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
