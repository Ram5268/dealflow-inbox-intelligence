// Brief 41 (H9), Brief 41.1: estate, probate, divorce, a death, illness, age and
// similar personal circumstances are never stored or shown. The extractors don't
// ask for them, and anything a model returns anyway is dropped here before
// saving (a motivation or status entirely; any sentence, line or clause of a
// title, summary or reason that mentions one).

// When an owner "passed" is ordinary rather than a death: passed on (or over)
// an offer, the house or it; passed up; passed the board, inspection or title;
// passed by or through; passed the lead along. Any other "<owner, seller,
// homeowner, landlord, he, she> passed" reads as a death, including at the end
// of a line ("Owner passed\nThree units.").
const DET = 'the|a|an|our|their|his|her|its|my|your|this|that|these|those|both|all|every|each|any|several|multiple|two|three|four|five'
const ADJ = 'first|second|third|last|latest|new|initial|final|best|highest|higher|lower|lowest|low|high|lowball|strong|weak|cash|all-cash|verbal|written|full|full-price|asking|above-asking|over-asking|below-asking|counter|competing|backup|back-up|other|another|same|one|original|revised|current|previous|\\$?\\d[\\d,.]*[km]?'
const DEAL = 'offers?|bids?|deals?|price|terms|propert(?:y|ies)|house|homes?|buildings?|listings?|units?|apartments?|place|contracts?|counter-?offers?|proposals?|opportunit(?:y|ies)|chance|buyers?|showings?|leases?|renewals?|financing|loans?|mortgages?|rates?|studios?|condos?|co-?ops?|townhouses?|brownstones?|lofts?|duplex(?:es)?|triplex(?:es)?|lots?|parcels?|spaces?|portfolio|package|\\d+\\s*-?(?:br|bd|bed(?:room)?s?|family)|it|them|that|this|those|these|one|ones|everything|us|me|him|(?:buying|selling|renting|renewing|signing|bidding|countering|offering|making|moving|listing|accepting)\\b'
const CHECK = 'boards?|inspections?|title|appraisals?|background\\s+checks?|credit\\s+checks?|reviews?|interviews?|tests?|exams?|bar|approvals?|walk-?throughs?|underwriting|muster|requirements?|screenings?|votes?'
const HANDOFF = 'leads?|referrals?|info(?:rmation)?|details|word|messages?|notes?|contacts?|numbers?|emails?|keys'
const PASSED_ORDINARY = [
  `\\s+(?:on|over)\\s+(?:(?:${DET}|${ADJ})\\s+){0,3}(?:${DEAL})\\b`,
  '\\s+up\\b',
  `\\s+(?:(?:${DET})\\s+)?(?:(?:co-?op|condo|building|final|city|home)\\s+)?(?:${CHECK})\\b`,
  '\\s+(?:by|through|along|around)\\b',
  `\\s+(?:(?:${DET})\\s+)?(?:${HANDOFF})\\s+(?:along|on|over|to)\\b`,
].join('|')
const OWNER_PASSED = `(?:owners?|sellers?|homeowners?|landlords?|he|she|who|(?:mr|mrs|ms|miss|dr)\\.?(?:\\s+[a-z]+){1,2})\\s+(?:(?:has|had|have|recently|just|sadly|suddenly|unexpectedly|since|also)\\s+){0,2}passed\\b(?!${PASSED_ORDINARY})`

const RELATIVE = '(?:mother|father|mom|dad|husband|wife|spouse|parents?|grand(?:mother|father|ma|pa|parents?)|aunt|uncle|brother|sister|son|daughter)'
const PERSON = `(?:owners?|sellers?|homeowners?|landlords?|partner|child|children|${RELATIVE}|(?:mr|mrs|ms|miss|dr)\\b)`

// "Separating" or "splitting up" is a couple's only when nothing it acts on
// follows: "the Smiths are separating" vs "the owner is separating the lots".
const SEP_OBJECT = '\\s+(?:the|a|an|this|that|these|those|its|two|three|four|five|both|each|all|\\d+|lots?|units?|parcels?|propert(?:y|ies)|buildings?|apartments?|meters?|utilities|spaces?|rooms?|floors?|kitchens?|bedrooms?|entrances?|walls?|fences?|doors?|lines?|partitions?)\\b|\\s+(?:from\\s+(?:the|a|an|its)|into)\\b'
const SPLIT_OBJECT = '\\s+(?:the|a|an|this|that|these|those|its|two|three|four|five|\\d+|lots?|units?|parcels?|propert(?:y|ies)|buildings?|apartments?|floors?|space|rooms?)\\b|\\s+into\\b'

const PERSONAL = new RegExp(
  [
    // Divorce, separation, family conflict
    'probat\\w*', 'divorc\\w*', 'marital', 'matrimonial', 'custody', 'alimony', 'child\\s+support', 'estrang\\w*',
    'ex[\\s-]?(?:wife|wives|husbands?|spouses?|partners?|girlfriend|boyfriend|fianc[eé]e?)', '(?:his|her|their|my|your)\\s+ex(?!-)',
    'former\\s+(?:husband|wife|spouse|partner)s?', 'separation\\s+(?:agreement|papers)', '(?:legal|trial)\\s+separation',
    `(?:couple|spouses?|husband|wife|partners|parents|they|we)\\s+(?:(?:have|had|recently|just|legally|finally)\\s+){0,2}separat(?:ed|ing)\\b(?!${SEP_OBJECT})`,
    `(?:are|is|was|were|['’]re|['’]s|been|being|be|getting|got|gets|get)\\s+(?:(?:now|currently|recently|legally|finally)\\s+)?separat(?:ed|ing)\\b(?!${SEP_OBJECT})`,
    `(?:splitting|split|splits|breaking|broke|breaks)\\s+up\\b(?!${SPLIT_OBJECT})`,
    'family\\s+(?:reasons|issues|matters|problems|emergenc(?:y|ies)|tragedy|crisis)',
    // A death, an estate, an inheritance
    'passed\\s+away', '(?:his|her|their)\\s+passing', "\\w+['’]s\\s+passing(?!\\s+(?:grade|score|mark|lane|traffic))",
    `passing\\s+of\\s+(?:(?:the|his|her|their|my|our|a|an)\\s+)?(?:late\\s+)?${PERSON}`,
    'bereave\\w*', 'letters\\s+testamentary', 'letters?\\s+of\\s+administration', "surrogate(?:['’]s|s)?\\s+court",
    'decedents?', 'intestate', 'obituar(?:y|ies)', '(?:passed|handed)\\s+down', 'no\\s+longer\\s+with\\s+us',
    'guardianship', 'conservatorship',
    `(?:late|deceased)\\s+(?:husband|wife|spouse|mother|father|mom|dad|parents?|owners?|grand(?:mother|father|ma|pa)|(?:mr|mrs|ms|miss|dr)\\b)`,
    `${RELATIVE}\\s+(?:(?:has|had|recently|just|sadly|suddenly)\\s+){0,2}(?:passed|died)`,
    OWNER_PASSED,
    'lost\\s+(?:his|her|their|a)\\s+(?:husband|wife|spouse|mother|father|mom|dad|parents?|son|daughter|child)',
    'deceased', 'deaths?', 'died', 'dies', 'dying', 'dead', 'funeral', 'widow\\w*',
    'heirs?', 'inherit\\w*', 'executors?', 'co-executors?', 'executrix', 'administratrix', 'estates?',
    // Illness and care
    '(?:terminally|seriously|chronically|very)\\s+ill(?!-)', '(?:is|was|are|were|been|got|gets|getting|became|become|becomes|being|fell|falls)\\s+ill(?!-)', 'illness(?:es)?',
    'sick(?:ly|ness|er)?', '(?:poor|failing|declining|bad|frail|fragile|deteriorating|ill)\\s+health',
    '(?:health|medical)\\s+(?:issues?|problems?|reasons?|conditions?|concerns?|scares?|crisis|decline|emergenc(?:y|ies)|bills?|treatments?)',
    'terminal(?:ly)?\\s+(?:ill\\w*|diagnos\\w*|cancer|conditions?|disease|prognosis)', 'diagnosed\\s+with',
    'strokes?', 'hospitali[sz](?:ed|ation|ations)',
    '(?:in|into|out\\s+of|admitted\\s+to|rushed\\s+to|taken\\s+to|discharged\\s+from|released\\s+from)\\s+(?:(?:the|a)\\s+)?hospital',
    'chemo(?:therapy)?', 'radiation\\s+(?:therapy|treatments?)', 'dialysis', 'palliative', 'hospice',
    'cancer', 'tumou?rs?', 'leukemia', 'lymphoma', 'multiple\\s+sclerosis', 'parkinson\\w*', 'alzheimer\\w*', 'dementia',
    'heart\\s+(?:attack|failure|condition|surgery)', 'disabilit(?:y|ies)',
    'memory\\s+care', 'care\\s+(?:homes?|facilit(?:y|ies))', 'caregivers?', 'home\\s+health', 'nursing\\s+homes?', 'assisted\\s+living',
    // Age (a demographic)
    'elderly', '(?:aging|ageing|aged)\\s+(?:owners?|sellers?|homeowners?|landlords?|parents?|mother|father|mom|dad|couple|widow\\w*|relatives?)',
    'seniors?\\s+(?:citizens?|owners?|homeowners?|sellers?|landlords?|couple)',
    '\\d{2,3}[\\s-]+years?[\\s-]+old\\s+(?:owners?|sellers?|homeowners?|landlords?|mother|father|man|woman|lady|gentleman|widow\\w*|parents?|couple)',
    "in\\s+(?:his|her|their)\\s+(?:early\\s+|mid[\\s-]?|late\\s+)?(?:[2-9]0['’]?s|twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)",
  ]
    .map((p) => `\\b(?:${p})\\b`)
    .join('|'),
  'i',
)

// Ordinary phrases that contain those words (removed before the check).
const BUILDING_TYPE = '(?:(?:nursing|funeral|care)\\s+homes?|assisted[\\s-]+living(?:\\s+(?:facility|facilities|residence|building))?)'
const BENIGN = new RegExp(
  [
    'real[\\s-]+estates?', 'estate[\\s-]+(?:agents?|sized|style)', 'jamaica\\s+estates', 'estates\\s+at',
    '\\w+\\s+estates\\s+(?:condo|co-?op|building|development)s?',
    'dead[\\s-]+end', 'dead[\\s-]?bolts?', 'death[\\s-]+defying', 'drop[\\s-]*dead', 'dead[\\s-]+(?:set|space)',
    '(?:deal|listing|sale|contract|offer|bid|escrow|financing|loan|mortgage|application|project|negotiations?|transaction)s?\\s+(?:(?:is|was|has|had|have|just|basically|now|already|then|seems|looks|looked|went)\\s+){0,2}(?:died|dead|dies|dying)',
    'died\\s+down', 'dying\\s+to', 'ill[\\s-]+(?:fated|advised)',
    // A buyer inherits the tenants or the lease (never "inherited": that's an owner's inheritance).
    'inherit(?:s|ing)?\\s+(?:(?:the|a|an|all|any|two|three|four|five|six|\\d+|existing|current|in-place|rent[\\s-]stabilized|rent[\\s-]controlled|stabilized|regulated|long[\\s-]term|paying|good|great|its|occupied|residential|commercial)\\s+){0,3}(?:tenants?|tenancy|tenancies|leases?|occupants?|rent[\\s-]rolls?|rents?)',
    "widow['’]?s[\\s-]+walks?",
    // A nursing or funeral home as a building, not where someone is going.
    `(?:across\\s+(?:the\\s+street\\s+)?from|next\\s+(?:door\\s+)?to|near(?:by)?|beside|behind|adjacent\\s+to|opposite|former(?:ly)?|converted|vacant|old|abandoned|closed|shuttered|existing)\\s+(?:(?:a|an|the)\\s+)?(?:former\\s+)?${BUILDING_TYPE}`,
    `${BUILDING_TYPE}\\s+(?:building|site|property|conversion|use|zoning|parcel|lot)s?`,
    'separated\\s+by\\s+(?:(?:a|an|the|\\d+)\\s+)?(?:[\\w-]+\\s+)?(?:courtyards?|yards?|gardens?|walls?|fences?|hallways?|halls?|driveways?|streets?|alleys?|alleyways?|walkways?|breezeways?|lobb(?:y|ies)|stair(?:case|well)?s?|lots?|feet|ft|foot|blocks?|buildings?|garages?|patios?|terraces?|partitions?|doors?|floors?|landings?|corridors?)',
    'sick\\s+(?:and\\s+tired\\s+)?of', 'strokes?\\s+of\\s+(?:luck|genius|good\\s+(?:luck|fortune)|midnight)', '(?:brush|pen|key|master)[\\s-]?strokes?',
  ]
    .map((p) => `\\b(?:${p})\\b`)
    .join('|'),
  'gi',
)
// "<Name> Estates" is a place ("Bayside Estates two-family"); "The Estates…" or
// "Smith Estates are selling" is not.
const NAMED_ESTATES = /\b(?!(?:The|A|An|His|Her|Their|Its|Our|My|Your|This|That|These|Those|Both|All|Two|Three|Four|Five|Several|Many|Some|Any|No|Each|Every)\b)[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+Estates\b(?!\s+(?:is|are|was|were|will|has|have|had|of|sells?|selling|sold|wants?)\b)/g

export function mentionsPersonalCircumstances(text: string | null | undefined): boolean {
  return !!text && PERSONAL.test(text.replace(NAMED_ESTATES, ' ').replace(BENIGN, ' '))
}

// A motivation that mentions any of them is dropped entirely.
export function safeMotivation(motivation: string | null | undefined): string | null {
  const m = motivation?.trim()
  return m && !mentionsPersonalCircumstances(m) ? m : null
}

// Where free text splits into pieces that are kept or dropped whole: a sentence
// end (not after Mr./Dr./St. …; also when the next sentence follows with no
// space, "list.Divorce"), a line break, a semicolon, or a spaced dash.
const ABBREV = '(?<!\\b(?:Mr|Mrs|Ms|Dr|St|Ave|Jr|Sr|Apt|No))'
const PIECE_BREAK = new RegExp(
  `((?<=${ABBREV}[.!?]["')\\]]?)\\s+|(?<=[a-z]${ABBREV}[.!?])(?=[A-Z])|[ \\t]*\\n\\s*|[ \\t]*;\\s*|\\s+[-–—]+\\s+)`,
)
// A line break inside a sentence (no end mark before it, the next line starts
// in lowercase) isn't a break: "She passed\naway last year." is one sentence.
const SOFT_LINE_BREAK = /(?<![.!?:;"')\]])[ \t]*\n\s*(?=[a-z])/g

// Free text without the pieces that mention them. Unchanged text comes back as
// it was. A dropped piece takes its break with it; sentences and lines rejoin
// with a space, and a semicolon or dash between kept pieces stays.
export function withoutPersonalCircumstances(text: string): string {
  if (!mentionsPersonalCircumstances(text)) return text
  const parts = text.replace(SOFT_LINE_BREAK, ' ').split(PIECE_BREAK)
  let out = ''
  let glue = ''
  for (let i = 0; i < parts.length; i += 2) {
    const piece = parts[i]
    if (!piece.trim() || mentionsPersonalCircumstances(piece)) continue
    out += glue + piece
    const brk = parts[i + 1] ?? ''
    glue = brk.trim() ? brk : ' '
  }
  out = out.trim()
  // A phrase split across pieces comes back whole when they're joined: fail closed.
  return mentionsPersonalCircumstances(out) ? '' : out
}

// A seller lead's summary as stored: the safe summary plus a safe motivation.
export function sellerSummary(summary: string, motivation: string | null | undefined): string {
  const safe = withoutPersonalCircumstances(summary)
  const m = safeMotivation(motivation)
  return m ? `${safe} Motivation: ${m}`.trim() : safe
}

// A lead's status (free text from the model) without them: unchanged when it
// mentions none, null when nothing is left.
export function safeStatus(status: string | null | undefined): string | null {
  if (status == null) return null
  if (!mentionsPersonalCircumstances(status)) return status
  return withoutPersonalCircumstances(status) || null
}

// A lead's title, summary and classification reason made safe. A title that
// mentions a personal circumstance is replaced (titles are short and shown
// everywhere); an emptied reason gets a plain one.
export function safeLeadText(lead: {
  title: string
  summary: string
  reason: string
  motivation?: string | null
  fallbackTitle: string
}): { title: string; summary: string; reason: string } {
  const reason = withoutPersonalCircumstances(lead.reason)
  return {
    title: mentionsPersonalCircumstances(lead.title) ? lead.fallbackTitle : lead.title,
    summary: sellerSummary(lead.summary, lead.motivation),
    reason: reason || 'Classified from the email; personal details left out.',
  }
}

// The categories whose free text can carry them (a seller's or landlord's
// reasons for selling or renting).
export const LEAD_CATEGORIES: ReadonlySet<string> = new Set(['SELLER_LEAD', 'LANDLORD_LEAD'])

// A client conversation's free text is filtered too, unless the client is
// plainly a buyer or renter: a seller's or landlord's conversation, and one
// whose side the model couldn't tell, can carry them (Brief 41.1).
const DEMAND_SIDES: ReadonlySet<string> = new Set(['buyer', 'renter'])
export function conversationNeedsFilter(clientSide: string | null | undefined): boolean {
  return !DEMAND_SIDES.has(clientSide?.trim().toLowerCase() ?? '')
}

// A client conversation's title, summary and reason as stored.
export function safeConversationText(c: {
  clientSide: string | null | undefined
  title: string
  summary: string
  reason: string
  fallbackTitle: string
}): { title: string; summary: string; reason: string } {
  if (!conversationNeedsFilter(c.clientSide)) return { title: c.title, summary: c.summary, reason: c.reason }
  return safeLeadText({ title: c.title, summary: c.summary, reason: c.reason, fallbackTitle: c.fallbackTitle })
}

export function leadFallbackTitle(category: string, place: string | null | undefined): string {
  const kind = category === 'LANDLORD_LEAD' ? 'Landlord lead' : category === 'CLIENT_CONVERSATION' ? 'Client conversation' : 'Seller lead'
  return place?.trim() ? `${kind} – ${place.trim()}` : kind
}
