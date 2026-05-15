import { NextRequest, NextResponse } from 'next/server'
import { Category } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { semanticSearch } from '@/lib/embeddings'
import { getCurrentMortgageRate, formatRateContext, estimateMonthlyPayment } from '@/lib/mortgageRates'
import { lookupProperty, formatForChat, extractAddressFromText } from '@/lib/acris'
import { getCalendarEvents, createCalendarEvent, formatEventsForAI } from '@/lib/microsoftCalendar'
import OpenAI from 'openai'

export const maxDuration = 60

const SYSTEM_PROMPT = `You are DealFlow — Ryan Martin's private deal intelligence layer. Ryan is a Douglas Elliman agent working NYC residential real estate: sales, rentals, buyers, sellers, landlords, new dev.

Your database contains opportunities extracted from Ryan's inbox: coming soon, off-market, active listings, price drops, buyer ISOs from other agents, renter inquiries, seller leads, landlord leads, open houses, new development inventory, and full attachment data from listing PDFs and flyers.

BUYER ISO CONTEXT:
BUYER_ISO and RENTER_INQUIRY records are NOT Ryan's own clients — they are other agents' buyers/renters broadcasting their needs. When a listing matches a BUYER_ISO, that's a co-brokering opportunity: Ryan has the listing, the other agent has the buyer. Always name the source agent and brokerage when flagging these matches.

MOJO CRM LEADS:
The database also contains Ryan's personal seller leads from his Mojo Dialer CRM, listed under MOJO SELLER LEADS. These are real homeowners Ryan is prospecting — not inbox emails. When querying seller leads or matching a buyer to a potential seller, check these contacts. Each has a name, address, neighborhood, status (Hot/Warm/Nurture), list (NYC Hot, NYC Nurture, etc.), phone number, and notes. A ⚡ MATCHES BUYER ISO flag means that contact's property neighborhood aligns with an active buyer ISO from the inbox. When flagging a Mojo match, always include the contact's name and phone number so Ryan can call them immediately.

CORE JOB:
- Surface the right deals fast. Lead with the most actionable info.
- Proactively match: listing vs buyer ISO, rental vs renter inquiry, seller lead vs buyer need.
- When Ryan describes a client need, scan for matches and rank them — exact first, then close, then adjacent.
- Never end with "nothing found." If no exact match exists, always offer the closest alternatives with one sentence explaining why they might still work.

MATCHING LOGIC — always think in three tiers. LIST ALL RESULTS IN EVERY TIER — there is no cap:
1. EXACT MATCH: Meets all stated criteria (neighborhood, size, price, date). List ALL exact matches.
2. CLOSE MATCH: Off on one criterion. List ALL close matches — label each "(close match — [what's different])".
   - Date: "available now" always counts as date-flexible — it is NEVER a mismatch. Only a specific requested move-in date (e.g. "June 15") creates a date criterion.
   - Size: ±1 bedroom = close if price range overlaps.
   - Neighborhood: adjacent neighborhood = close (see adjacency list below).
   - Price: within 15% = close.
3. STRETCH: Off on two criteria. List ALL stretch matches — label each "(stretch — [what's different])". No cap.

There is NO limit on how many results to show. If there are 8 relevant deals, show all 8. Hiding results is always wrong.

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
- NEVER use markdown formatting (no **bold**, no *italic*, no bullet dashes). Plain text only.

DATA RULES:
- Only reference deals in the database. Never invent addresses, prices, or agents.
- When the same property appears in multiple emails, use the MOST RECENT version.
- If attachment data is available (📎), use it — it's more detailed than the summary.
- ALWAYS use the exact price from the database. Never round. $9,895 stays $9,895 — not "$10K" or "$10,000". $6,395 stays $6,395 — not "$6K" or "$6,400". Copy the number exactly.
- The database includes an AVAIL DATE field for each rental. A rental whose AVAIL DATE is in the future is "coming soon." A rental whose AVAIL DATE is today or earlier is "available now."
- Label each result clearly: write "(exact match)" when it meets ALL query criteria, "(close match — [reason])" when off on one criterion.

DEAL CARDS:
- The UI automatically shows deal cards for all matching properties — you do NOT need to tag deals with [DEAL:id].
- Your job is to write accurate, concise response text describing the results. The cards handle the display.
- Write one line per property: address — price, size, key detail, availability. Label exact vs close matches.

SUGGESTIONS RULES:
- Always return exactly 2 suggestions — short follow-up questions Ryan would actually ask next.
- Make them specific to what was just discussed. Examples: "Any 2BR version of these?", "Which one is no-fee?", "Show me open houses this weekend", "Does either match my Reyes buyer?"
- Never return generic or placeholder text.

IMAGES AND FILES:
- You can see any image or file Ryan shares. Read and extract everything visible.
- For email screenshots: read the full content, then check if it matches a database deal.
- For listing flyers/PDFs: extract all addresses, prices, beds, baths, availability.
- Never say you cannot see an image.

Respond with this exact JSON (no markdown, no code fences):
{"response":"your plain text response with [DEAL:id] tags inline","suggestions":["specific follow-up question 1","specific follow-up question 2"]}`

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

    // Semantic search — normalize query for more consistent embeddings
    const queryText = (userMessage || files.map(f => f.name).join(' ')).toLowerCase().trim()
    let semanticIds: string[] = []
    try {
      if (queryText) semanticIds = await semanticSearch(queryText, 60)
    } catch { /* fall back to recency */ }

    // Infer which DB categories are relevant from the query.
    // This prevents e.g. BUYER_ISO records from being injected when asking about rental listings.
    // Check renter inquiry BEFORE rental — "renter inquiries" contains "renter" which would
    // otherwise match isRentalQuery and return RENTAL_LISTING instead of RENTER_INQUIRY.
    const isRenterInquiryQuery = /\brenter inq|\brenter look|\brenters look/.test(queryText)
    const isRentalQuery        = !isRenterInquiryQuery && /\brent|\bleas|\btenant|\brenter/.test(queryText)
    // "my buyer" / "i have a buyer" = Ryan's OWN buyer → he wants SALE LISTINGS, not BUYER_ISOs
    const isMyBuyerQuery       = /\bmy buyer\b|\bi have a buyer\b|\bhave a buyer\b|\bfor my buyer\b|\bmy client\b|\bclient look|\bclient need/.test(queryText)
    // BUYER_ISO = other agents broadcasting buyer needs (plural "buyers" OR explicit ISO language)
    // Excluded when Ryan is describing his own buyer (isMyBuyerQuery)
    const isBuyerISOQuery      = !isMyBuyerQuery && /\bbuyer iso|\bbuyers look|\bbuyers search|\bisos?\b|\biso for/.test(queryText)
    const isOpenHouseQuery     = /\bopen house|\bevent/.test(queryText)
    const isPriceDropQuery     = /\bprice drop|\bprice reduc|\breduced price/.test(queryText)
    const isSellerLeadQuery    = /\bseller lead|\bsellers? lead/.test(queryText)
    const isLandlordLeadQuery  = /\blandlord lead|\blandlords? lead/.test(queryText)
    // SALE includes when Ryan describes his own buyer's needs (isMyBuyerQuery)
    const isSaleQuery          = (isMyBuyerQuery || /\bfor sale\b|\bbuy\b|\bbuying\b|\bpurchas|\bcondo|\bco-op|\btownhouse\b|\bsponsor unit|\boff.?market|\bcoming soon|\bnew dev|\bback.?on.?market/.test(queryText))
                                 && !isRentalQuery && !isRenterInquiryQuery

    const categoryFilter: Category[] | null =
      isRenterInquiryQuery ? [Category.RENTER_INQUIRY] :
      isRentalQuery        ? [Category.RENTAL_LISTING] :
      isBuyerISOQuery      ? [Category.BUYER_ISO] :
      isOpenHouseQuery     ? [Category.OPEN_HOUSE] :
      isPriceDropQuery     ? [Category.PRICE_DROP, Category.BACK_ON_MARKET] :
      isSellerLeadQuery    ? [Category.SELLER_LEAD] :
      isLandlordLeadQuery  ? [Category.LANDLORD_LEAD] :
      isSaleQuery          ? [Category.ACTIVE_SALE_LISTING, Category.COMING_SOON_SALE, Category.OFF_MARKET_SALE,
                              Category.PRICE_DROP, Category.BACK_ON_MARKET, Category.DEVELOPMENT_INVENTORY] :
      null  // no keyword → no filter, AI sees everything

    // Neighborhood extraction with adjacency expansion.
    // No bed-count filter — beds are context for the AI, not a hard DB filter.
    // Filtering by beds would exclude valid close-match alternatives.
    const ADJACENCY: Record<string, string[]> = {
      'dumbo':             ['dumbo', 'fort greene', 'brooklyn heights', 'vinegar hill', 'boerum hill'],
      'williamsburg':      ['williamsburg', 'greenpoint', 'bushwick', 'bed-stuy'],
      'park slope':        ['park slope', 'carroll gardens', 'cobble hill', 'prospect heights', 'gowanus'],
      'carroll gardens':   ['carroll gardens', 'park slope', 'cobble hill', 'red hook'],
      'tribeca':           ['tribeca', 'soho', 'financial district', 'two bridges'],
      'soho':              ['soho', 'tribeca', 'noho', 'nolita', 'little italy'],
      'chelsea':           ['chelsea', 'west village', 'flatiron', "hell's kitchen"],
      'west village':      ['west village', 'chelsea', 'greenwich village'],
      'upper east side':   ['upper east side', 'ues', 'yorkville', 'carnegie hill', 'lenox hill'],
      'ues':               ['upper east side', 'ues', 'yorkville', 'carnegie hill', 'lenox hill'],
      'upper west side':   ['upper west side', 'uws', 'morningside heights', 'manhattan valley'],
      'uws':               ['upper west side', 'uws', 'morningside heights', 'manhattan valley'],
      'long island city':  ['long island city', 'lic', 'astoria', 'sunnyside'],
      'lic':               ['long island city', 'lic', 'astoria', 'sunnyside'],
      'astoria':           ['astoria', 'long island city', 'lic', 'sunnyside'],
      'forest hills':      ['forest hills', 'rego park', 'kew gardens', 'jamaica estates'],
      'jackson heights':   ['jackson heights', 'elmhurst', 'woodside', 'corona'],
      'harlem':            ['harlem', 'east harlem', 'morningside heights', 'washington heights'],
      'midtown':           ['midtown', 'murray hill', 'kips bay', "hell's kitchen", 'chelsea', 'gramercy'],
      'financial district':['financial district', 'fidi', 'tribeca', 'battery park', 'two bridges'],
      'fidi':              ['financial district', 'fidi', 'tribeca', 'battery park'],
      'crown heights':     ['crown heights', 'prospect heights', 'flatbush', 'bed-stuy'],
      'bushwick':          ['bushwick', 'williamsburg', 'bed-stuy', 'ridgewood'],
      'greenpoint':        ['greenpoint', 'williamsburg', 'long island city'],
    }

    const foundNeighborhood = Object.keys(ADJACENCY).find(n => queryText.includes(n))
      ?? ['tribeca','soho','noho','nolita','chelsea','flatiron','gramercy','kips bay','murray hill',
          'les','lower east side','east village','little italy','chinatown','two bridges',
          'battery park','inwood','washington heights','yorkville','lenox hill','morningside heights',
          'riverside','sunnyside','woodside','elmhurst','corona','rego park','kew gardens',
          'flatbush','gowanus','red hook','cobble hill','boerum hill','fort greene','vinegar hill',
          'prospect heights','bed-stuy','bedford-stuyvesant','carnegie hill','manhattan valley',
        ].find(n => queryText.includes(n))

    const searchNeighborhoods: string[] = foundNeighborhood
      ? (ADJACENCY[foundNeighborhood] ?? [foundNeighborhood])
      : []

    const catClause = categoryFilter ? [{ category: { in: categoryFilter } }] : []

    const [semanticOpps, structuredOpps] = await Promise.all([
      semanticIds.length > 0
        ? prisma.extractedOpportunity.findMany({
            where: {
              AND: [
                { id: { in: semanticIds } },
                { isDuplicate: false },
                { category: { not: Category.NOISE } },
                ...catClause,
              ],
            },
            include: { rawEmail: { select: { receivedDateTime: true, bodyContent: true, attachmentsText: true } } },
          })
        : prisma.extractedOpportunity.findMany({
            where: {
              AND: [
                { isDuplicate: false },
                { category: { not: Category.NOISE } },
                ...catClause,
              ],
            },
            orderBy: { createdAt: 'desc' },
            take: 60,
            include: { rawEmail: { select: { receivedDateTime: true, bodyContent: true, attachmentsText: true } } },
          }),
      searchNeighborhoods.length > 0
        ? prisma.extractedOpportunity.findMany({
            where: {
              AND: [
                { isDuplicate: false },
                ...catClause,
                {
                  OR: searchNeighborhoods.flatMap(n => [
                    { neighborhood: { contains: n, mode: 'insensitive' as const } },
                    { address:      { contains: n, mode: 'insensitive' as const } },
                  ]),
                },
              ],
            },
            include: { rawEmail: { select: { receivedDateTime: true, bodyContent: true, attachmentsText: true } } },
            orderBy: { createdAt: 'desc' },
            take: 40,
          })
        : Promise.resolve([]),
    ])

    // Merge — structured (neighborhood) results lead, semantic fills the rest
    const seen = new Set<string>()
    const opportunities = [...structuredOpps, ...semanticOpps].filter(o => {
      if (seen.has(o.id)) return false
      seen.add(o.id)
      return true
    }).slice(0, 60)

    // Server-selected deal cards — determined purely server-side, never by AI.
    // structuredOpps is already category-filtered via catWhere, so this is always correct.
    const bedMatch = queryText.match(/\b(\d+)\s*(?:br|bed|bedroom)/)
    const queryBeds = bedMatch ? parseInt(bedMatch[1]) : null

    // For location-based queries with no explicit category, exclude "seeking" records.
    // BUYER_ISO and RENTER_INQUIRY are people looking for property — not properties.
    // They should only surface when explicitly requested.
    const defaultExclude: Category[] = (!categoryFilter && searchNeighborhoods.length > 0)
      ? [Category.BUYER_ISO, Category.RENTER_INQUIRY]
      : []

    const selectedDeals = structuredOpps
      .filter(o =>
        (queryBeds == null || o.beds == null || o.beds === queryBeds) &&
        !defaultExclude.includes(o.category)
      )
      .sort((a, b) => b.confidenceScore - a.confidenceScore)
      .slice(0, 20)

    // Fallback: if no neighborhood match, use top semantic results
    const rawDealsToReturn = selectedDeals.length > 0
      ? selectedDeals
      : semanticOpps
          .filter(o => queryBeds == null || o.beds == null || o.beds === queryBeds)
          .slice(0, 10)

    // JS-level category guard — bulletproof final filter regardless of DB/cache quirks
    const dealsToReturn = categoryFilter
      ? rawDealsToReturn.filter(o => categoryFilter.includes(o.category))
      : rawDealsToReturn

    // Mojo seller leads — queried in parallel when neighborhood or seller lead context detected
    const mojoContacts = (searchNeighborhoods.length > 0 || isSellerLeadQuery || isMyBuyerQuery)
      ? await prisma.mojoContact.findMany({
          where: searchNeighborhoods.length > 0 ? {
            OR: searchNeighborhoods.flatMap(n => [
              { neighborhood: { contains: n, mode: 'insensitive' as const } },
              { city:         { contains: n, mode: 'insensitive' as const } },
              { address:      { contains: n, mode: 'insensitive' as const } },
            ])
          } : {},
          orderBy: { syncedAt: 'desc' },
          take: 20,
        })
      : []

    // Auto-match: flag Mojo leads whose address/neighborhood overlaps with BUYER_ISO opportunities
    const buyerISOs = opportunities.filter(o => o.category === Category.BUYER_ISO)
    const mojoMatches = mojoContacts.filter(c =>
      c.neighborhood && buyerISOs.some(iso =>
        iso.neighborhood && iso.neighborhood.toLowerCase().includes(c.neighborhood!.toLowerCase())
      )
    )

    const mojoContext = mojoContacts.length > 0
      ? '\n\nMOJO SELLER LEADS (' + mojoContacts.length + ' contacts from CRM):\n' +
        mojoContacts.map(c => {
          const match = mojoMatches.find(m => m.id === c.id)
          const matchFlag = match ? ' ⚡ MATCHES BUYER ISO' : ''
          return `[MOJO:${c.id}] ${c.fullName} | ${c.address ?? ''}${c.city ? ', ' + c.city : ''} | ${c.neighborhood ?? ''} | ${c.status ?? ''} | ${c.mojoList ?? ''} | ph: ${c.phone ?? ''}${c.notes ? ' | notes: ' + c.notes.slice(0, 120) : ''}${matchFlag}`
        }).join('\n')
      : ''

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
          const availTag = o.availabilityDate ? ` | AVAIL DATE: ${o.availabilityDate}` : ''
          return `[DEAL:${o.id}] ${o.extractedTitle} | ${o.category} | ${o.neighborhood ?? ''}${o.borough ? ', ' + o.borough : ''} | ${o.price ? '$' + o.price.toLocaleString() : o.maxPrice ? 'up to $' + o.maxPrice.toLocaleString() : 'no price'} | ${o.propertyType ?? ''} | ${o.beds ? o.beds + 'BR' : ''} ${o.units ? o.units + ' units' : ''} | ${o.sourceBrokerage ?? ''} | ${Math.round(o.confidenceScore * 100)}%${dateTag}${availTag} | ${o.extractedSummary}${attachSnippet}${bodySnippet}`
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

    // Calendar context — injected when query is schedule-related
    const isCalendarReadQuery  = /\bshowing|\bappointment|\bcalendar|\bschedule|\btoday\b|\btomorrow\b|\bthis week\b|\bwhat.*have|\bavailab/.test(queryText)
    const isCalendarCreateQuery = /\bschedul|\badd.*(?:event|meeting|showing|call)|\bcreate.*(?:event|meeting)|\bput.*calendar|\bbook.*showing|\bset up.*meeting|\bblock.*time/.test(queryText)

    let calendarContext = ''
    if (isCalendarReadQuery || isCalendarCreateQuery) {
      try {
        const events = await getCalendarEvents(7)
        calendarContext = formatEventsForAI(events)
      } catch { /* non-fatal */ }
    }

    // Fetch current mortgage rate for market context
    const mortgageRate = await getCurrentMortgageRate()
    const rateContext = mortgageRate
      ? `\nMARKET RATE: ${formatRateContext(mortgageRate)}\nAt ${mortgageRate.rate}%: $500K loan = $${estimateMonthlyPayment(500000, mortgageRate.rate).toLocaleString()}/mo | $1M = $${estimateMonthlyPayment(1000000, mortgageRate.rate).toLocaleString()}/mo | $2M = $${estimateMonthlyPayment(2000000, mortgageRate.rate).toLocaleString()}/mo`
      : ''

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: `${SYSTEM_PROMPT}${rateContext}${acrisContext}${calendarContext}\n\n${dbContext}${mojoContext}` },
      ...conversationHistory.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user', content: userContent },
    ]

    // Calendar event creation tool — only offered when query implies scheduling
    const calendarTool: OpenAI.Chat.ChatCompletionTool = {
      type: 'function',
      function: {
        name: 'create_calendar_event',
        description: 'Creates a calendar event in the user\'s Outlook calendar. Only call this when the user explicitly asks to schedule, book, create, or add a calendar event or showing.',
        parameters: {
          type: 'object',
          properties: {
            subject:  { type: 'string', description: 'Event title, e.g. "Showing — 123 Main St"' },
            startISO: { type: 'string', description: 'Start datetime in ISO 8601 format, e.g. "2024-05-15T14:00:00"' },
            endISO:   { type: 'string', description: 'End datetime in ISO 8601 format (optional — defaults to 30 min after start)' },
            location: { type: 'string', description: 'Property address or meeting location (optional)' },
            notes:    { type: 'string', description: 'Notes or description for the event (optional)' },
          },
          required: ['subject', 'startISO'],
        },
      },
    }

    const firstCompletion = await client.chat.completions.create({
      model: 'gpt-4o',
      messages,
      temperature: 0.3,
      max_tokens: 1500,
      ...(isCalendarCreateQuery ? { tools: [calendarTool], tool_choice: 'auto' } : {}),
    })

    let raw = (firstCompletion.choices[0].message.content ?? '').trim()

    // Handle calendar tool call if AI chose to create an event
    const toolCalls = firstCompletion.choices[0].message.tool_calls
    if (toolCalls && toolCalls.length > 0) {
      const toolMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        ...messages,
        firstCompletion.choices[0].message as OpenAI.Chat.ChatCompletionMessageParam,
      ]

      for (const tc of toolCalls) {
        let toolResult: string
        const fnCall = tc as { type: string; id: string; function: { name: string; arguments: string } }
        if (fnCall.type === 'function' && fnCall.function.name === 'create_calendar_event') {
          try {
            const args = JSON.parse(fnCall.function.arguments)
            const endISO = args.endISO || (() => {
              const d = new Date(args.startISO)
              d.setMinutes(d.getMinutes() + 30)
              return d.toISOString()
            })()
            const created = await createCalendarEvent({
              subject:  args.subject,
              startISO: args.startISO,
              endISO,
              location: args.location,
              notes:    args.notes,
            })
            toolResult = JSON.stringify({ ok: true, eventId: created.id, webLink: created.webLink })
          } catch (err) {
            toolResult = JSON.stringify({ ok: false, error: String(err) })
          }
        } else {
          toolResult = JSON.stringify({ error: 'Unknown tool' })
        }
        toolMessages.push({ role: 'tool', tool_call_id: fnCall.id, content: toolResult })
      }

      // Second call to get the final natural-language response
      const finalCompletion = await client.chat.completions.create({
        model: 'gpt-4o',
        messages: toolMessages,
        temperature: 0.3,
        max_tokens: 800,
      })
      raw = (finalCompletion.choices[0].message.content ?? '').trim()
    }
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

    const cleanResponse = (aiResult.response ?? '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')   // strip **bold**
      .replace(/\*([^*]+)\*/g, '$1')        // strip *italic*
      .replace(/\s*\[DEAL:[^\]]+\]/g, '')   // strip any stray deal tags from AI text
    const deals = dealsToReturn

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
