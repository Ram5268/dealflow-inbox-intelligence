export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { Category } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { semanticSearch } from '@/lib/embeddings'
import { getCurrentMortgageRate, formatRateContext, estimateMonthlyPayment } from '@/lib/mortgageRates'
import { lookupProperty, formatForChat, extractAddressFromText } from '@/lib/acris'
import { getCalendarEvents, createCalendarEvent, formatEventsForAI } from '@/lib/microsoftCalendar'
import OpenAI from 'openai'

export const maxDuration = 60

const SYSTEM_PROMPT = `You are Drift — Ryan Martin's private real estate deal intelligence layer. Ryan is a Douglas Elliman agent working NYC residential real estate across all transaction types.

Your full behavior rules are defined in DEALFLOW_AI.md. Follow them exactly. Key rules summarized here:

DATA AVAILABLE:
- DATABASE: Up to 60 classified email opportunities (all 19 categories) with full details, prices, attachments
- MOJO CRM: Ryan's personal NYC seller leads — real property owners he's prospecting. Shown under MOJO SELLER LEADS. Always include name + phone when flagging a Mojo match.
- CALENDAR: Ryan's Outlook schedule (read + propose with confirmation)
- ACRIS: NYC property records (when triggered)
- MORTGAGE RATES: Current rate context (always present)

BUYER ISO RULE: BUYER_ISO and RENTER_INQUIRY are OTHER agents' clients — not Ryan's. When a listing matches a BUYER_ISO, it's a co-brokering opportunity. Always name the source agent and brokerage.

CALENDAR PROTOCOL: When Ryan asks to schedule anything — PROPOSE first, do not create immediately.
Format: I'll create: [title], [Day Date] at [time][, at [location]]. Reply "confirm" to add it to your Outlook.
Only create after receiving "confirm", "yes", "do it", or similar explicit confirmation.

MATCHING: Three tiers — EXACT (all criteria met), CLOSE (off on one: ±1BR, adjacent neighborhood, within 15% price, within 7 days date), STRETCH (off on two). Show ALL results in every tier — no cap. "Available now" is NEVER a date mismatch.

RESPONSE FORMAT: Plain text only. No markdown, no bold, no italics, no bullet dashes. One line per listing: [Address] — $[exact price], [beds]BR, [neighborhood]. [key detail]. Available [date]. (exact match)

PRICES: Never round. $9,895 stays $9,895. Copy exactly.
ATTACHMENTS: If 📎 attachment data exists, use it — it's more detailed than the summary.
SUGGESTIONS: Always return exactly 2 specific follow-up questions.
NO FILLER: No "feel free to ask", no "I hope that helps", no "I cannot find" without an alternative.

Respond with this exact JSON (no markdown, no code fences):
{"response":"your plain text response","suggestions":["specific follow-up 1","specific follow-up 2"],"pendingEvent":null}`

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

    // ── INTENT DETECTION ──────────────────────────────────────────────────────
    // Priority order matters — check more specific patterns before general ones.

    // Demand-side queries (other agents' clients)
    const isRenterInquiryQuery  = /\brenter inq|\brenter look|\brenters look|\brenter inquir/.test(queryText)
    const isBuyerISOQuery       = !(/\bmy buyer|\bi have a buyer|\bhave a buyer|\bfor my buyer|\bmy client|\bclient look|\bclient need/.test(queryText))
                                  && /\bbuyer iso|\bbuyers? look|\bbuyers? search|\bisos?\b|\biso for|\bany iso|\bany buyer/.test(queryText)

    // Ryan's own clients (wants listings not ISOs)
    const isMyBuyerQuery        = /\bmy buyer\b|\bi have a buyer\b|\bhave a buyer\b|\bfor my buyer\b|\bmy client\b|\bclient look|\bclient need/.test(queryText)

    // Rental-side
    const isComingSoonRentalQuery = /\bcoming soon rental|\brental coming soon|\bcoming available|\bavailability coming|\bunits coming/.test(queryText)
    const isRentalQuery           = !isRenterInquiryQuery && !isComingSoonRentalQuery
                                    && /\brent|\bleas|\btenant|\brenter|\bapartment|\bapts?\b/.test(queryText)
                                    && !/\bfor sale|\bbuy|\bpurchas|\bcondo|\bco-op|\bcoming soon sale/.test(queryText)

    // Sale-side
    const isComingSoonSaleQuery   = /\bcoming soon sale|\bpre-?market|\boff.?market coming|\bcoming soon\b/.test(queryText)
                                    && !isComingSoonRentalQuery
    const isOffMarketQuery        = /\boff.?market|\bpocket listing|\bquiet sale|\bprivate listing/.test(queryText)
    const isSponsorUnitQuery      = /\bsponsor unit|\boffering plan|\bsponsor sale|\bno board/.test(queryText)
    const isNewDevQuery           = /\bnew dev|\bnew development|\bnew construction|\bdevelopment inventory/.test(queryText)
    const isPriceDropQuery        = /\bprice drop|\bprice reduc|\breduced price|\bjust reduced|\bprice cut/.test(queryText)
    const isBackOnMarketQuery     = /\bback on market|\bback.?on.?market|\breturned to market/.test(queryText)
    const isOpenHouseQuery        = /\bopen house|\bbroker open|\bbroker preview/.test(queryText)
    const isSaleQuery             = (isMyBuyerQuery || /\bfor sale\b|\bbuy\b|\bbuying\b|\bpurchas|\bcondo\b|\bco-op\b|\btownhouse\b|\bsponsor\b|\boff.?market|\bback.?on.?market|\bnew dev|\bcoming soon/.test(queryText))
                                    && !isRentalQuery && !isRenterInquiryQuery && !isComingSoonRentalQuery

    // Lead-side
    const isSellerLeadQuery     = /\bseller lead|\bsellers? lead|\bwho can i call|\bpotential seller|\bcold call|\bprospect/.test(queryText)
    const isLandlordLeadQuery   = /\blandlord lead|\blandlords? lead|\blandlord prospect|\brental owner/.test(queryText)

    // Informational
    const isMarketReportQuery   = /\bmarket report|\bmarket stat|\babsorption|\bmarket data|\bwhat.?s the market|\bmarket condition/.test(queryText)
    const isRealEstateEventQuery = /\bnetworking event|\bgrand opening|\bbroker event|\bcompany event|\bnew dev event/.test(queryText)

    // Calendar
    const isCalendarReadQuery   = /\bshowing|\bappointment|\bcalendar|\bschedule|\btoday\b|\btomorrow\b|\bthis week\b|\bwhat.*have|\bavailab/.test(queryText)
    const isCalendarCreateQuery = /\bschedul|\bbook\b|\bset up\b|\bblock.*time|\badd.*(?:event|meeting|showing|call|appointment)|\bcreate.*(?:event|meeting|appointment)|\bput.*calendar|\bcalendar.*invite|\bsend.*invite/.test(queryText)

    // Check for pending confirmation from last AI message
    const lastAssistantMsg = history.filter(m => m.role === 'assistant').slice(-1)[0]
    let lastPendingEvent: Record<string, string> | null = null
    if (lastAssistantMsg?.content) {
      try {
        const parsed = JSON.parse(lastAssistantMsg.content)
        if (parsed?.pendingEvent) lastPendingEvent = parsed.pendingEvent
      } catch { /* not JSON */ }
    }
    const isConfirmMessage = lastPendingEvent != null
      && /\bconfirm\b|\byes\b|\bdo it\b|\blooks good\b|\bgo ahead\b|\badd it\b/.test(queryText)

    // ── CATEGORY FILTER ───────────────────────────────────────────────────────
    const categoryFilter: Category[] | null =
      isRenterInquiryQuery      ? [Category.RENTER_INQUIRY] :
      isComingSoonRentalQuery   ? [Category.COMING_SOON_RENTAL] :
      isRentalQuery             ? [Category.RENTAL_LISTING, Category.COMING_SOON_RENTAL] :
      isBuyerISOQuery           ? [Category.BUYER_ISO] :
      isOpenHouseQuery          ? [Category.OPEN_HOUSE] :
      isPriceDropQuery          ? [Category.PRICE_DROP, Category.BACK_ON_MARKET] :
      isBackOnMarketQuery       ? [Category.BACK_ON_MARKET] :
      isSellerLeadQuery         ? [Category.SELLER_LEAD] :
      isLandlordLeadQuery       ? [Category.LANDLORD_LEAD] :
      isSponsorUnitQuery        ? [Category.SPONSOR_UNIT, Category.DEVELOPMENT_INVENTORY] :
      isNewDevQuery             ? [Category.DEVELOPMENT_INVENTORY, Category.SPONSOR_UNIT, Category.COMING_SOON_SALE] :
      isOffMarketQuery          ? [Category.OFF_MARKET_SALE, Category.COMING_SOON_SALE] :
      isComingSoonSaleQuery     ? [Category.COMING_SOON_SALE, Category.OFF_MARKET_SALE] :
      isMarketReportQuery       ? [Category.MARKET_REPORT] :
      isRealEstateEventQuery    ? [Category.REAL_ESTATE_EVENT, Category.OPEN_HOUSE] :
      isSaleQuery               ? [Category.ACTIVE_SALE_LISTING, Category.COMING_SOON_SALE, Category.OFF_MARKET_SALE,
                                   Category.PRICE_DROP, Category.BACK_ON_MARKET, Category.DEVELOPMENT_INVENTORY,
                                   Category.SPONSOR_UNIT] :
      null  // general query — no filter, but defaultExclude still applies below

    // ── NEIGHBORHOOD EXTRACTION (multi-neighborhood, full NYC map) ─────────
    const ADJACENCY: Record<string, string[]> = {
      // Manhattan Downtown
      'tribeca':            ['tribeca', 'soho', 'financial district', 'two bridges', 'battery park city', 'little italy'],
      'soho':               ['soho', 'tribeca', 'noho', 'nolita', 'little italy', 'west village', 'hudson square'],
      'noho':               ['noho', 'soho', 'nolita', 'east village', 'greenwich village'],
      'nolita':             ['nolita', 'soho', 'noho', 'little italy', 'lower east side'],
      'little italy':       ['little italy', 'soho', 'nolita', 'chinatown', 'lower east side'],
      'chinatown':          ['chinatown', 'lower east side', 'two bridges', 'little italy', 'financial district'],
      'lower east side':    ['lower east side', 'les', 'east village', 'chinatown', 'two bridges', 'nolita'],
      'les':                ['lower east side', 'les', 'east village', 'chinatown', 'two bridges'],
      'two bridges':        ['two bridges', 'lower east side', 'chinatown', 'financial district'],
      'financial district': ['financial district', 'fidi', 'tribeca', 'battery park city', 'two bridges', 'chinatown'],
      'fidi':               ['financial district', 'fidi', 'tribeca', 'battery park city', 'two bridges'],
      'battery park city':  ['battery park city', 'financial district', 'tribeca'],
      // Manhattan Mid
      'west village':       ['west village', 'chelsea', 'greenwich village', 'hudson square', 'soho'],
      'greenwich village':  ['greenwich village', 'west village', 'noho', 'east village', 'chelsea'],
      'east village':       ['east village', 'lower east side', 'greenwich village', 'noho', 'kips bay'],
      'chelsea':            ["chelsea", 'west village', "hell's kitchen", 'flatiron', 'hudson yards'],
      "hell's kitchen":     ["hell's kitchen", 'chelsea', 'midtown west', 'hudson yards'],
      'hells kitchen':      ["hell's kitchen", 'chelsea', 'midtown west'],
      'flatiron':           ['flatiron', 'chelsea', 'gramercy', 'union square', 'midtown south'],
      'gramercy':           ['gramercy', 'flatiron', 'kips bay', 'murray hill', 'union square'],
      'union square':       ['union square', 'flatiron', 'gramercy', 'east village', 'chelsea'],
      'kips bay':           ['kips bay', 'gramercy', 'murray hill', 'east village', 'turtle bay'],
      'murray hill':        ['murray hill', 'kips bay', 'midtown east', 'gramercy', 'turtle bay'],
      'turtle bay':         ['turtle bay', 'midtown east', 'murray hill', 'kips bay'],
      'hudson yards':       ['hudson yards', 'chelsea', "hell's kitchen", 'midtown west'],
      'hudson square':      ['hudson square', 'soho', 'west village', 'tribeca'],
      // Manhattan Midtown
      'midtown':            ['midtown', 'murray hill', 'kips bay', "hell's kitchen", 'chelsea', 'gramercy', 'midtown east', 'midtown west'],
      'midtown east':       ['midtown east', 'midtown', 'turtle bay', 'murray hill', 'upper east side'],
      'midtown west':       ['midtown west', 'midtown', "hell's kitchen", 'hudson yards'],
      // Manhattan Upper
      'upper west side':    ['upper west side', 'uws', 'morningside heights', 'manhattan valley', 'lincoln square', 'riverside'],
      'uws':                ['upper west side', 'uws', 'morningside heights', 'manhattan valley', 'lincoln square'],
      'upper east side':    ['upper east side', 'ues', 'yorkville', 'carnegie hill', 'lenox hill', 'east harlem'],
      'ues':                ['upper east side', 'ues', 'yorkville', 'carnegie hill', 'lenox hill'],
      'yorkville':          ['yorkville', 'upper east side', 'carnegie hill', 'east harlem'],
      'carnegie hill':      ['carnegie hill', 'upper east side', 'yorkville', 'upper west side'],
      'lenox hill':         ['lenox hill', 'upper east side', 'midtown east'],
      'morningside heights':['morningside heights', 'upper west side', 'harlem', 'washington heights'],
      'manhattan valley':   ['manhattan valley', 'upper west side', 'harlem'],
      'lincoln square':     ['lincoln square', 'upper west side'],
      'riverside':          ['riverside', 'upper west side'],
      'harlem':             ['harlem', 'east harlem', 'morningside heights', 'washington heights', 'manhattan valley'],
      'east harlem':        ['east harlem', 'harlem', 'yorkville', 'upper east side'],
      'washington heights': ['washington heights', 'harlem', 'inwood', 'morningside heights'],
      'inwood':             ['inwood', 'washington heights'],
      'riverdale':          ['riverdale', 'kingsbridge', 'fieldston'],
      'kingsbridge':        ['kingsbridge', 'riverdale', 'marble hill'],
      // Brooklyn
      'williamsburg':       ['williamsburg', 'greenpoint', 'bushwick', 'bed-stuy', 'east williamsburg'],
      'greenpoint':         ['greenpoint', 'williamsburg', 'long island city', 'hunters point'],
      'bushwick':           ['bushwick', 'williamsburg', 'bed-stuy', 'ridgewood', 'east williamsburg'],
      'bed-stuy':           ['bed-stuy', 'bedford-stuyvesant', 'bushwick', 'crown heights', 'fort greene', 'clinton hill'],
      'bedford-stuyvesant': ['bed-stuy', 'bedford-stuyvesant', 'bushwick', 'crown heights', 'fort greene'],
      'crown heights':      ['crown heights', 'bed-stuy', 'prospect heights', 'flatbush', 'east flatbush'],
      'prospect heights':   ['prospect heights', 'crown heights', 'park slope', 'fort greene', 'flatbush'],
      'park slope':         ['park slope', 'prospect heights', 'carroll gardens', 'cobble hill', 'gowanus', 'south slope'],
      'south slope':        ['south slope', 'park slope', 'gowanus', 'greenwood heights'],
      'carroll gardens':    ['carroll gardens', 'park slope', 'cobble hill', 'red hook', 'boerum hill'],
      'cobble hill':        ['cobble hill', 'carroll gardens', 'park slope', 'boerum hill', 'brooklyn heights'],
      'boerum hill':        ['boerum hill', 'cobble hill', 'carroll gardens', 'fort greene', 'downtown brooklyn'],
      'fort greene':        ['fort greene', 'boerum hill', 'clinton hill', 'bed-stuy', 'downtown brooklyn'],
      'clinton hill':       ['clinton hill', 'fort greene', 'bed-stuy', 'prospect heights'],
      'brooklyn heights':   ['brooklyn heights', 'cobble hill', 'downtown brooklyn', 'dumbo', 'boerum hill'],
      'dumbo':              ['dumbo', 'brooklyn heights', 'vinegar hill', 'downtown brooklyn', 'fort greene'],
      'vinegar hill':       ['vinegar hill', 'dumbo', 'brooklyn heights'],
      'downtown brooklyn':  ['downtown brooklyn', 'brooklyn heights', 'boerum hill', 'dumbo', 'fort greene'],
      'red hook':           ['red hook', 'carroll gardens', 'gowanus', 'sunset park'],
      'gowanus':            ['gowanus', 'park slope', 'carroll gardens', 'red hook', 'sunset park'],
      'greenwood heights':  ['greenwood heights', 'park slope', 'sunset park', 'south slope'],
      'sunset park':        ['sunset park', 'bay ridge', 'gowanus', 'borough park', 'red hook'],
      'bay ridge':          ['bay ridge', 'sunset park', 'dyker heights', 'fort hamilton'],
      'flatbush':           ['flatbush', 'crown heights', 'prospect heights', 'east flatbush', 'ditmas park'],
      'ditmas park':        ['ditmas park', 'flatbush', 'kensington', 'prospect park south'],
      'east flatbush':      ['east flatbush', 'flatbush', 'crown heights', 'brownsville'],
      'brownsville':        ['brownsville', 'bed-stuy', 'east new york', 'crown heights'],
      'ridgewood':          ['ridgewood', 'bushwick', 'maspeth', 'glendale'],
      // Queens
      'long island city':   ['long island city', 'lic', 'astoria', 'sunnyside', 'hunters point', 'greenpoint'],
      'lic':                ['long island city', 'lic', 'astoria', 'sunnyside', 'hunters point'],
      'hunters point':      ['hunters point', 'long island city', 'lic', 'sunnyside'],
      'astoria':            ['astoria', 'long island city', 'lic', 'sunnyside', 'jackson heights'],
      'sunnyside':          ['sunnyside', 'astoria', 'long island city', 'woodside', 'jackson heights'],
      'jackson heights':    ['jackson heights', 'elmhurst', 'woodside', 'corona', 'sunnyside'],
      'elmhurst':           ['elmhurst', 'jackson heights', 'corona', 'woodside', 'maspeth', 'rego park'],
      'woodside':           ['woodside', 'sunnyside', 'jackson heights', 'elmhurst', 'maspeth'],
      'corona':             ['corona', 'jackson heights', 'elmhurst', 'flushing', 'rego park'],
      'rego park':          ['rego park', 'forest hills', 'elmhurst', 'corona', 'kew gardens'],
      'forest hills':       ['forest hills', 'rego park', 'kew gardens', 'jamaica estates', 'fresh meadows'],
      'kew gardens':        ['kew gardens', 'forest hills', 'rego park', 'richmond hill', 'jamaica'],
      'jamaica':            ['jamaica', 'kew gardens', 'richmond hill', 'south jamaica', 'hollis'],
      'richmond hill':      ['richmond hill', 'kew gardens', 'jamaica', 'ozone park', 'woodhaven'],
      'ozone park':         ['ozone park', 'richmond hill', 'woodhaven', 'howard beach'],
      'howard beach':       ['howard beach', 'ozone park', 'lindenwood'],
      'flushing':           ['flushing', 'fresh meadows', 'corona', 'bayside', 'murray hill queens'],
      'bayside':            ['bayside', 'flushing', 'little neck', 'douglaston', 'fresh meadows'],
      'little neck':        ['little neck', 'bayside', 'douglaston', 'great neck'],
      'douglaston':         ['douglaston', 'little neck', 'bayside'],
      'maspeth':            ['maspeth', 'ridgewood', 'woodside', 'elmhurst', 'middle village', 'glendale'],
      'middle village':     ['middle village', 'maspeth', 'glendale', 'ridgewood'],
      'glendale':           ['glendale', 'ridgewood', 'middle village', 'maspeth'],
    }

    // Extract ALL neighborhoods mentioned in query (not just first)
    const allFoundNeighborhoods = Object.keys(ADJACENCY).filter(n => queryText.includes(n))

    // Also check secondary list for neighborhoods not in adjacency map
    const secondaryNeighborhoods = [
      'tribeca','soho','noho','nolita','chelsea','flatiron','gramercy','kips bay','murray hill',
      'lower east side','east village','little italy','chinatown','two bridges','battery park',
      'inwood','washington heights','yorkville','lenox hill','morningside heights','harlem',
      'east harlem','sunnyside','woodside','elmhurst','corona','rego park','kew gardens',
      'flatbush','gowanus','red hook','cobble hill','boerum hill','fort greene','vinegar hill',
      'prospect heights','bed-stuy','bedford-stuyvesant','carnegie hill','manhattan valley',
      'greenwood heights','south slope','clinton hill','east flatbush','ditmas park','brownsville',
      'hunters point','fresh meadows','jamaica estates','hollis','woodhaven',
    ].filter(n => !allFoundNeighborhoods.includes(n) && queryText.includes(n))

    const mentionedNeighborhoods = [...allFoundNeighborhoods, ...secondaryNeighborhoods]

    // Borough-level fallback
    const boroughFallback: string[] = []
    if (mentionedNeighborhoods.length === 0) {
      if (queryText.includes('brooklyn')) boroughFallback.push('brooklyn')
      if (queryText.includes('queens')) boroughFallback.push('queens')
      if (queryText.includes('bronx')) boroughFallback.push('bronx')
      if (queryText.includes('staten island')) boroughFallback.push('staten island')
      if (queryText.includes('manhattan') && !queryText.includes('lower manhattan')) boroughFallback.push('manhattan')
    }

    // Expand each mentioned neighborhood with its adjacents, dedup
    const expandedNeighborhoods = new Set<string>()
    for (const n of mentionedNeighborhoods) {
      const adjacents = ADJACENCY[n] ?? [n]
      adjacents.forEach(a => expandedNeighborhoods.add(a))
    }
    for (const b of boroughFallback) expandedNeighborhoods.add(b)

    const searchNeighborhoods: string[] = [...expandedNeighborhoods]

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

    // Always exclude BUYER_ISO and RENTER_INQUIRY from general queries.
    // They are "seeking" records, not inventory — only show when explicitly requested.
    const defaultExclude: Category[] = !categoryFilter
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

    // Handle confirm fast-path — create the pending calendar event directly
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
        await prisma.chatMessage.create({ data: { sessionId: session.id, role: 'user', content: storedUser } })
        await prisma.chatMessage.create({ data: { sessionId: session.id, role: 'assistant', content: confirmText, dealsJson: [], suggestions: [] } })
        await prisma.chatSession.update({ where: { id: session.id }, data: { updatedAt: new Date() } })
        return NextResponse.json({ sessionId: session.id, response: confirmText, deals: [], suggestions: [] })
      } catch (err) {
        // Fall through to normal AI if creation fails
        console.error('[DealFlow] Calendar confirm error:', err)
      }
    }

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

    const firstCompletion = await client.chat.completions.create({
      model: 'gpt-4o',
      messages,
      temperature: 0.3,
      max_tokens: 1500,
    })

    const raw = (firstCompletion.choices[0].message.content ?? '').trim()
    console.log('[DealFlow] Raw AI response:', raw.slice(0, 200))

    // Parse JSON robustly
    let aiResult: { response: string; suggestions: string[]; pendingEvent?: Record<string, string> | null }
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

    // Store pendingEvent in assistant message content as JSON so confirm flow can read it
    const pendingEvent = aiResult.pendingEvent ?? null
    const storedAssistantContent = pendingEvent
      ? JSON.stringify({ response: cleanResponse, suggestions: aiResult.suggestions ?? [], pendingEvent })
      : cleanResponse

    // Save messages to this session
    await prisma.chatMessage.create({ data: { sessionId: session.id, role: 'user', content: storedMsg } })
    await prisma.chatMessage.create({
      data: {
        sessionId: session.id,
        role: 'assistant', content: storedAssistantContent,
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
