// Brief 41 (H9), Brief 41.1: estate, probate, divorce, a death, illness, age and
// similar personal circumstances are never stored or shown. The extractors don't
// ask for them, and anything a model returns anyway is dropped here before
// saving (a motivation or status entirely; any sentence or line of a title,
// summary or reason that mentions one).

// When an owner "passed" is ordinary rather than a death: passed on (or over)
// an offer, the house or it; passed up; passed the board, inspection or title;
// passed by or through; passed the lead along, or passed something to me or us;
// passed at asking; passed for now; passed, not interested. Any other "<owner,
// seller, homeowner, landlord, he, she, a relative> passed" reads as a death,
// also with a word or an aside before "passed" ("The owner, John Smith,
// sadly passed") and at the end of a line ("Owner passed\nThree units.").
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
  '\\s+(?:it|them|this|that)\\s+(?:along|over)\\b',
  `\\s+(?:me|us|him|her|them)\\s+(?:${DET})\\b`,
  '\\s+(?:(?:the|this|that|a|an|his|her|their|our|my)\\s+)?[\\w-]+(?:\\s+[\\w-]+)?\\s+(?:along\\s+|over\\s+)?to\\s+(?:me|us|you)\\b',
  '\\s+at\\s+(?:\\$|asking\\b|full\\s+price\\b|\\d[\\d,.]*\\s*(?:k|m|mm|million)\\b)',
  '\\s+for\\s+(?:now|the\\s+time\\s+being)\\b',
  '\\s+this\\s+time(?!\\s+(?:last|next|of|around|a|in|two|three|\\d))\\b',
  '\\s+because\\s+(?:the|our|their|of\\s+the)\\s+(?:price|offer|bid|terms|numbers?|valuation|appraisal|commission)\\b',
  '\\s*[,:;—–-]+\\s*(?:not\\s+interested|no\\s+thanks)\\b',
].join('|')
const RELATIVE = '(?:mother|father|mom|dad|husband|wife|spouse|parents?|grand(?:mother|father|ma|pa|parents?)|aunt|uncle|brother|sister|son|daughter)'
const PASSED_BY = `(?:owners?|sellers?|homeowners?|landlords?|he|she|who|partners?|${RELATIVE}|(?:mr|mrs|ms|miss|dr)\\.?(?:\\s+[a-z]+){1,2})`
const BEFORE_PASSED = 'has|had|have|now|recently|just|sadly|suddenly|unexpectedly|unfortunately|tragically|both|all|also|since|and|then|finally|peacefully|quietly|apparently|reportedly|already'
const ASIDE = ",\\s*(?:[\\w.'’-]+\\s+){0,3}[\\w.'’-]+\\s*,"
const OWNER_PASSED = `${PASSED_BY}(?:\\s*${ASIDE})?\\s+(?:(?:${BEFORE_PASSED})\\s+){0,3}passed\\b(?!${PASSED_ORDINARY})`
const PERSON = `(?:owners?|sellers?|homeowners?|landlords?|partner|child|children|${RELATIVE}|(?:mr|mrs|ms|miss|dr)\\b)`
// Someone whose age or health is theirs: never a building (so not "they":
// "They are 100 years old" is usually the houses).
const SOMEONE = `(?:owners?|sellers?|homeowners?|landlords?|he|she|couple|widow\\w*|${RELATIVE})`

// "Separating" or "splitting up" is a couple's only when nothing it acts on
// follows: "the Smiths are separating" vs "the owner is separating the lots".
const SEP_OBJECT = '\\s+(?:the|a|an|this|that|these|those|its|two|three|four|five|both|each|all|\\d+|lots?|units?|parcels?|propert(?:y|ies)|buildings?|apartments?|meters?|utilities|spaces?|rooms?|floors?|kitchens?|bedrooms?|entrances?|walls?|fences?|doors?|lines?|partitions?)\\b|\\s+(?:from\\s+(?:the|a|an|its|unit|apartment|apt|floor|room)|into)\\b'
const SPLIT_OBJECT = '\\s+(?:the|a|an|this|that|these|those|its|it|them|everything|two|three|four|five|\\d+|lots?|units?|parcels?|propert(?:y|ies)|buildings?|apartments?|floors?|space|rooms?|evenly|equally|half|proceeds|costs?|commission|fees?|rent|bills?)\\b|\\s+into\\b'
// "is", "are", "was", "were", also "she's" or "they're".
const IS = "(?:\\s+(?:is|are|was|were)|['’](?:s|re))"
// Ages that are a count of something else: "the owner is 20 minutes away".
const NOT_AN_AGE = '(?![\\d/%]|[.,]\\d|\\s*(?:units?|feet|ft|sq|square|percent|famil(?:y|ies)|beds?|bedrooms?|baths?|minutes?|mins?|blocks?|days?|weeks?|months?|stories|storeys|floors?|miles?|k\\b|m\\b))'

const PERSONAL = new RegExp(
  [
    // Divorce, separation, family conflict
    'probat\\w*', 'divorc\\w*', 'marital', 'matrimonial', 'custody', 'alimony', 'child\\s+support', 'estrang\\w*',
    'ex[\\s-]?(?:wife|wives|husbands?|spouses?|partners?|girlfriend|boyfriend|fianc[eé]e?)',
    "(?:the|his|her|their|my|your|owner['’]s|seller['’]s|soon[\\s-]to[\\s-]be)\\s+ex(?!-)",
    'former\\s+(?:husband|wife|spouse|partner)s?', 'separation\\s+(?:agreement|papers)', '(?:legal|trial)\\s+separation',
    '(?:going\\s+through|after|during|amid|following|pending)\\s+(?:(?:a|an|the|their|his|her)\\s+)?(?:(?:legal|trial|recent|messy|bitter)\\s+)?(?:separation|break[\\s-]?up)',
    `(?:couple|spouses?|husband|wife|partners|parents|they|we)\\s+(?:(?:have|had|recently|just|legally|finally)\\s+){0,2}separat(?:ed|ing)\\b(?!${SEP_OBJECT})`,
    `(?:are|is|was|were|['’]re|['’]s|been|being|be|getting|got|gets|get)\\s+(?:(?:now|currently|recently|legally|finally)\\s+)?separat(?:ed|ing)\\b(?!${SEP_OBJECT})`,
    `(?:splitting|split|splits|breaking|broke|breaks)\\s+up\\b(?!${SPLIT_OBJECT})`,
    `(?:couple|spouses?|they|we|owners)\\s+(?:(?:have|had|recently|just|finally)\\s+){0,2}split\\b(?!\\s+up)(?!${SPLIT_OBJECT})`,
    'break[\\s-]?ups?(?!\\s+(?:fees?|value|clause))', '(?:couple|spouses?|they|we)\\s+(?:(?:are|is|was|were|have|had)\\s+)?part(?:ing|ed)\\s+ways',
    'no\\s+longer\\s+together', '(?:husband|wife|spouse|partner)\\s+(?:(?:has|had|recently|just)\\s+)?moved\\s+out',
    'marriage\\s+(?:ended|is\\s+over|was\\s+over|fell\\s+apart|broke\\s+down|counsel\\w*|troubles?|problems?)', '(?:failed|failing|broken|ended|troubled|rocky)\\s+marriage',
    'family\\s+court', 'equitable\\s+distribution', 'restraining\\s+order', 'domestic\\s+(?:violence|abuse)', 'orders?\\s+of\\s+protection',
    'family\\s+(?:reasons|issues|matters|problems|emergenc(?:y|ies)|tragedy|crisis)',
    // A death, an estate, an inheritance
    'passed\\s+away', '(?:his|her|their)\\s+passing', "\\w+['’]s\\s+passing(?!\\s+(?:grade|score|mark|lane|traffic))",
    `passing\\s+of\\s+(?:(?:the|his|her|their|my|our|a|an)\\s+)?(?:late\\s+)?${PERSON}`,
    'bereave\\w*', 'letters\\s+testamentary', 'letters?\\s+of\\s+administration', "surrogate(?:['’]s|s)?\\s+court",
    'decedents?', 'intestate', 'obituar(?:y|ies)', '(?:passed|handed)\\s+down', 'no\\s+longer\\s+(?:alive|with\\s+us)',
    'no\\s+longer\\s+living(?!\\s+(?:there|here|in|at|on|upstairs|downstairs|nearby|locally|with))',
    'surviving\\s+(?:spouse|husband|wife|partner|children|kids|sons?|daughters?|family|heirs?|siblings?|relatives?)', 'survived\\s+by',
    'beneficiar(?:y|ies)', 'next\\s+of\\s+kin', '(?:per|in|under|by)\\s+(?:the|his|her|their|my)\\s+(?:last\\s+)?will(?!\\s+(?:of|be|not|to))',
    'griev(?:e|es|ed|ing)', 'grief', 'mourn(?:s|ed|ing)?', 'condolences?', 'sorry\\s+for\\s+(?:your|their|his|her|the)\\s+loss',
    'suicide', '(?:was|were|been|got)\\s+killed', 'killed\\s+(?:in|by|during)\\s+(?:a|an|the)', 'succumb\\w*', 'est\\.?\\s+of\\s+(?!\\d)',
    'guardianship', 'conservators?', 'conservatorship', 'court[\\s-]+appointed\\s+(?:guardian|conservator)s?', 'appointed\\s+(?:a\\s+)?(?:guardian|conservator)',
    'power\\s+of\\s+attorney', 'poa', 'incapacit\\w*', 'lacks?\\s+(?:mental\\s+)?capacity',
    `(?:late|deceased)\\s+(?:husband|wife|spouse|mother|father|mom|dad|parents?|owners?|grand(?:mother|father|ma|pa)|(?:mr|mrs|ms|miss|dr)\\b)`,
    OWNER_PASSED,
    'lost\\s+(?:his|her|their|a)\\s+(?:husband|wife|spouse|partner|mother|father|mom|dad|parents?|son|daughter|child|baby|life|lives|battle)',
    'deceased', 'deaths?', 'died', 'dies', 'dying', 'dead', 'funeral', 'widow\\w*',
    'heirs?', 'inherit\\w*', 'executors?', 'co-executors?', 'executrix', 'administratrix', 'estates?',
    // Illness, disability and care
    '(?:terminally|seriously|chronically|very|gravely|critically|severely)\\s+ill(?!-)', 'terminally', '(?:is|are|was|became|being)\\s+terminal',
    '(?:is|was|are|were|been|got|gets|getting|became|become|becomes|being|fell|falls)\\s+ill(?!-)', 'illness(?:es)?', 'unwell',
    'sick(?:ly|ness|er)?', '(?:poor|failing|declining|bad|frail|fragile|deteriorating|ill)[\\s-]+health', 'frail(?:ty)?',
    '(?:health|medical)\\s+(?:issues?|problems?|reasons?|conditions?|concerns?|scares?|crisis|decline|emergenc(?:y|ies)|bills?|treatments?)',
    'terminal(?:ly)?\\s+(?:ill\\w*|diagnos\\w*|cancer|conditions?|disease|prognosis)', 'diagnosed\\s+with',
    'undergoing\\s+(?:\\w+\\s+)?(?:treatments?|therapy|chemo\\w*|dialysis|surgery)',
    'strokes?', 'hospitali[sz](?:ed|ation|ations)', 'surger(?:y|ies)', 'injured', 'bed-?ridden', 'housebound', 'homebound',
    '(?:in|into|out\\s+of|admitted\\s+to|rushed\\s+to|taken\\s+to|went\\s+to|discharged\\s+from|released\\s+from)\\s+(?:(?:the|a)\\s+)?hospitals?(?!\\s+(?:district|zone|area|corridor|campus|buildings?|complex|center|centre|grade|parking))',
    'intensive\\s+care', 'icu', 'chemo(?:therapy)?', 'radiation\\s+(?:therapy|treatments?)', 'dialysis', 'palliative', 'hospice',
    'cancer', 'tumou?rs?', 'leukemia', 'lymphoma', 'multiple\\s+sclerosis', 'parkinson\\w*', 'alzheimer\\w*', 'dementia',
    'memory\\s+loss', 'cognitive\\s+(?:decline|impairment|issues?|problems?)', 'senil\\w*',
    'heart\\s+(?:attack|failure|condition|surgery|disease|problems?)', 'disabilit(?:y|ies)',
    `${SOMEONE}(?:${IS}|\\s+became|\\s+has\\s+been)\\s+(?:(?:now|permanently|severely|very)\\s+)?(?:disabled|depressed)`,
    'disabled\\s+(?:owners?|sellers?|homeowners?|landlords?|veterans?|mother|father|son|daughter|husband|wife|parents?)',
    '(?:has|with|suffers\\s+from|battling|struggling\\s+with)\\s+depression', '(?:uses|using|in|needs|confined\\s+to)\\s+a\\s+wheelchair',
    'care\\s+for\\s+(?:her|him|them)', `${SOMEONE}\\s+needs?\\s+care`,
    'needs?\\s+(?:(?:full|part)[\\s-]time|long[\\s-]term|constant|round[\\s-]the[\\s-]clock|24[\\s/-]7|nursing|medical|home)\\s+care',
    `${SOMEONE}${IS}\\s+in\\s+rehab`, `${SOMEONE}\\s+(?:has|had|with)\\s+(?:als|ms|copd|hiv|aids)`, 'memory[\\s-]+care', 'care[\\s-]+(?:homes?|facilit(?:y|ies))', 'caregivers?', 'home[\\s-]+health',
    'nursing[\\s-]+homes?', 'assisted[\\s-]+living', 'skilled\\s+nursing', 'long[\\s-]+term\\s+care',
    '(?:moving|moved|move|going|gone|went|relocating)\\s+(?:in)?to\\s+(?:(?:a|an)\\s+)?(?:senior\\s+(?:living|housing|residences?|homes?|communit(?:y|ies))|retirement\\s+(?:homes?|communit(?:y|ies)|villages?|facilit(?:y|ies)))',
    // Age (a demographic)
    'elderly', '(?:aging|ageing|aged|older)\\s+(?:owners?|sellers?|homeowners?|landlords?|parents?|mother|father|mom|dad|couple|man|woman|lady|gentleman|widow\\w*|relatives?)',
    'old\\s+(?:man|woman|lady|gentleman|couple)', 'retirees?',
    'retired\\s+(?:couple|owners?|sellers?|homeowners?|landlords?|parents?|widow\\w*|man|woman|lady|gentleman)',
    `${SOMEONE}${IS}\\s+(?:(?:now|recently|already)\\s+)?retired`, '(?:octo|nona|septua|sexa)genarians?', 'getting\\s+on\\s+in\\s+years',
    'seniors?\\s+(?:citizens?|owners?|homeowners?|sellers?|landlords?|couple|selling|downsizing)',
    `${SOMEONE}${IS}\\s+(?:a\\s+)?seniors?(?!\\s+(?:partner|vice|executive|manager|director|officer|associate|analyst|engineer|loan|broker|agent|vp|counsel|member|editor|consultant|advis[eo]r|designer|developer|architect|scientist|attorney|lawyer|accountant))`,
    `${SOMEONE}${IS}\\s+(?:(?:getting|too|very|quite|so)\\s+)?old(?:er)?`,
    `${SOMEONE}${IS}\\s+(?:(?:now|about|nearly|almost|over|around|past|pushing|aged?)\\s+)?\\d{2,3}${NOT_AN_AGE}`,
    `${SOMEONE}\\s*,\\s*(?:age\\s+|aged\\s+)?\\d{2,3}(?=\\s*,)`,
    '\\d{2,3}[\\s-]+years?[\\s-]+old\\s+(?:owners?|sellers?|homeowners?|landlords?|mother|father|man|woman|lady|gentleman|widow\\w*|parents?|couple)',
    "in\\s+(?:his|her|their)\\s+(?:early\\s+|mid[\\s-]?|late\\s+)?(?:[2-9]0['’]?s|twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)",
  ]
    .map((p) => `\\b(?:${p})\\b`)
    .join('|'),
  'i',
)

// Ordinary phrases that contain those words (removed before the check).
// A nursing or funeral home as a building, not where someone is going:
// "across from a nursing home", "former funeral home", "nursing home for sale".
const BUILDING_TYPE = '(?:(?:nursing|funeral|care)[\\s-]+homes?|assisted[\\s-]+living(?:\\s+facilit(?:y|ies))?)'
const SEPARATE_THING = '(?:bedrooms?|rooms?|lots?|units?|apartments?|apts?|floors?|meters?|utilities|gas|electric(?:ity)?|kitchens?|baths?|bathrooms?|entrances?|buildings?|parcels?|spaces?|garages?|yards?|wings?|sections?|stairs?|halls?|duplex(?:es)?|living\\s+(?:rooms?|areas?)|dining\\s+(?:rooms?|areas?))'
const DEAD_THING = '(?:deal|listing|sale|contract|offer|bid|escrow|financing|loan|mortgage|application|project|negotiations?|transaction|(?:1031\\s+)?exchange|market|heater|boiler|furnace|batter(?:y|ies)|roof|trees?|plants?|grass|lawn|engine|compressor|elevator|motor|pump|hvac|phone|car|signal|wifi|internet|leads?|showings?|momentum|buzz)'
const BENIGN = new RegExp(
  [
    'real[\\s-]+estates?', 'estate[\\s-]+(?:agents?|sized|style)', 'jamaica\\s+estates', 'estates\\s+at',
    '(?<=\\w\\s+)estates\\s+(?:condo|co-?op|building|development)s?', // only "estates co-op": the word before is still checked
    'dead[\\s-]+end', 'dead[\\s-]?bolts?', 'death[\\s-]+defying', 'drop[\\s-]*dead', 'dead[\\s-]+(?:set|space|rent|trees?|plants?|grass|lawn|leaves|wood|load|zones?|spots?|weight|air)',
    `${DEAD_THING}s?\\s+(?:(?:is|was|has|had|have|just|basically|now|already|then|seems|looks|looked|went|totally|completely)\\s+){0,2}(?:died|dead|dies|dying)`,
    'died\\s+down', 'dying\\s+to', 'ill[\\s-]+(?:fated|advised)',
    // A buyer inherits the tenants or the lease ("inheriting" or "inherited"
    // can be an owner's family inheriting the house).
    'inherits?\\s+(?:(?:the|a|an|all|any|two|three|four|five|six|\\d+|existing|current|in-place|rent[\\s-]stabilized|rent[\\s-]controlled|stabilized|regulated|long[\\s-]term|paying|good|great|its|occupied|residential|commercial)\\s+){0,3}(?:tenants?|tenancy|tenancies|leases?)',
    "widow['’]?s[\\s-]+walks?",
    `(?:across\\s+(?:the\\s+street\\s+)?from|next\\s+(?:door\\s+)?to|near(?:by)?|beside|behind|adjacent\\s+to|opposite|former(?:ly)?|converted|vacant|abandoned|closed|shuttered)\\s+(?:(?:a|an|the)\\s+)?(?:former\\s+)?${BUILDING_TYPE}`,
    `${BUILDING_TYPE}(?:\\s+(?:building|facility|facilities|property))?\\s+(?:for\\s+(?:sale|lease|rent)|conversions?|zoning|sites?|parcels?|lots?|use|tenants?|operators?|business|on\\s+the\\s+(?:ground|first|second|third|top)\\s+floor)`,
    'separated\\s+by\\s+(?:(?:a|an|the|\\d+)\\s+)?(?:[\\w-]+\\s+)?(?:courtyards?|yards?|gardens?|walls?|fences?|hallways?|halls?|driveways?|streets?|alleys?|alleyways?|walkways?|breezeways?|lobb(?:y|ies)|stair(?:case|well)?s?|lots?|feet|ft|foot|blocks?|buildings?|garages?|patios?|terraces?|partitions?|doors?|floors?|landings?|corridors?)',
    `${SEPARATE_THING}(?:\\s+(?:\\d+[a-z]?|[a-z]))?\\s+(?:are|is|were|was|can\\s+be|will\\s+be|have\\s+been|has\\s+been)\\s+(?:(?:fully|completely|physically|well)\\s+)?separated`,
    "(?:lots?|units?|parcels?|propert(?:y|ies)|buildings?|space|apartments?|floors?|rooms?|portfolio|proceeds|commission)\\s+(?:(?:can|could|can['’]t|cannot|couldn['’]t|may|might|will|won['’]t|would|wouldn['’]t|should|must|to|not|be|been|being|is|are|was|were|easily|legally|never|already|also)\\s+){0,4}split\\s+up",
    'sick\\s+(?:and\\s+tired\\s+)?of', 'sick\\s+building(?:\\s+syndrome)?', 'strokes?\\s+of\\s+(?:luck|genius|good\\s+(?:luck|fortune)|midnight)', '(?:brush|pen|key|master)[\\s-]?strokes?',
    'disabilit(?:y|ies)\\s+(?:access(?:ible|ibility)?|ramps?|compliant|compliance|friendly|parking|bathrooms?|entrances?|lifts?|elevators?)',
    'home[\\s-]+health\\s+(?:agency|agencies|company|companies|offices?|business|providers?)',
    '(?:dialysis|surgery|surgical|urgent[\\s-]+care|day[\\s-]+care|child[\\s-]+care|medical|chemo(?:therapy)?|cancer|rehab|physical\\s+therapy)\\s+(?:centers?|centres?|clinics?|tenants?|offices?|practices?|suites?|facilit(?:y|ies))',
    '(?:escrow|bank|deposit|securities|key|keys)\\s+custody', 'custody\\s+of\\s+(?:the\\s+)?(?:keys|deposit|funds|escrow|documents|files)',
    '(?:building|property|roof|boiler|market|economy|block|structure)\\s+(?:is\\s+|was\\s+)?in\\s+(?:poor|failing|good|bad|great|fine)\\s+health',
  ]
    .map((p) => `\\b(?:${p})\\b`)
    .join('|'),
  'gi',
)
// "<Name> Estates" is a place ("Bayside Estates two-family"), so the word
// "Estates" there is ordinary, but only that word: the words before it are
// still checked ("Inherited Jamaica Estates colonial" is caught). Not after
// "The/His/…", nor before "are selling", "sale" or similar (in any case).
const NAMED_ESTATES = /\b(?!(?:The|A|An|His|Her|Their|Its|Our|My|Your|This|That|These|Those|Both|All|Two|Three|Four|Five|Several|Many|Some|Any|No|Each|Every)\b)[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+Estates\b(?!\s+(?:[Ii]s|[Aa]re|[Ww]as|[Ww]ere|[Ww]ill|[Hh]as|[Hh]ave|[Hh]ad|[Oo]f|[Ss]ells?|[Ss]elling|[Ss]old|[Ww]ants?|[Ss]ales?|[Ll]iquidations?|[Aa]uctions?)\b)/g

export function mentionsPersonalCircumstances(text: string | null | undefined): boolean {
  return !!text && PERSONAL.test(text.replace(NAMED_ESTATES, (m) => m.replace(/Estates$/, ' ')).replace(BENIGN, ' '))
}

// A motivation that mentions any of them is dropped entirely.
export function safeMotivation(motivation: string | null | undefined): string | null {
  const m = motivation?.trim()
  return m && !mentionsPersonalCircumstances(m) ? m : null
}

// Free text is checked a line and a sentence at a time; each is kept or dropped
// whole. A line that carries on the sentence before it (no end mark before the
// break, the next line starts in lowercase: "She passed\naway last year.")
// joins it. A sentence ends at . ! or ? (not after Mr./Dr./St. …), also when the
// next one follows with no space ("list.Divorce"), but never inside a web
// address or an email ("www.Example.com", "jane.Doe@example.com"). Semicolons
// and dashes don't split: a sentence with any sensitive clause is dropped whole
// ("Divorce pending; wife keeps the house").
const ABBREVIATION = '(?:Mr|Mrs|Ms|Dr|St|Ave|Jr|Sr|Apt|No|Prof|Rev|Hon|Sgt|Capt|Lt|Col|Gen)'
const SENTENCE_BREAK = new RegExp(
  [
    `(?<=(?<!\\b${ABBREVIATION})[.!?]["')\\]]?)\\s+`,
    `(?<=(?:^|[\\s("'\\[])[A-Za-z]{2,}[.!?])(?<!(?:^|[\\s("'\\[])${ABBREVIATION}[.!?])(?=[A-Z][a-z]*(?:[\\s,;:!?)"']|[.!?](?:\\s|$)|$))`,
  ].join('|'),
)
const ENDS_SENTENCE = /[.!?:;"')\]]$/
const STARTS_LOWERCASE = /^[a-z]/

function linesOf(text: string): string[] {
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const last = lines.length - 1
    if (last >= 0 && STARTS_LOWERCASE.test(line) && !ENDS_SENTENCE.test(lines[last])) lines[last] = `${lines[last]} ${line}`
    else lines.push(line)
  }
  return lines
}

// Free text without the sentences (or lines) that mention them. Unchanged text
// comes back as it was.
export function withoutPersonalCircumstances(text: string): string {
  if (!mentionsPersonalCircumstances(text)) return text
  const out = linesOf(text)
    .flatMap((line) => line.split(SENTENCE_BREAK))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !mentionsPersonalCircumstances(sentence))
    .join(' ')
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

// The legacy extractor's results (lib/ai.ts; saved by the Outlook sync,
// re-extract and reclassify): a seller or landlord lead, or a conversation with
// a seller or landlord (or one whose side isn't clear), made safe, status
// included. Other results come back as they were.
export interface ExtractedText {
  category: string
  clientSide: string | null
  status: string | null
  address: string | null
  neighborhood: string | null
  extractedTitle: string
  extractedSummary: string
  classificationReason: string
}
export function withoutPersonalText<T extends ExtractedText>(r: T): T {
  const conversation = r.category === 'CLIENT_CONVERSATION'
  if (conversation ? !conversationNeedsFilter(r.clientSide) : !LEAD_CATEGORIES.has(r.category)) return r
  const t = safeLeadText({
    title: r.extractedTitle, summary: r.extractedSummary, reason: r.classificationReason,
    fallbackTitle: leadFallbackTitle(r.category, r.address ?? r.neighborhood),
  })
  return {
    ...r, extractedTitle: t.title, extractedSummary: t.summary, classificationReason: t.reason,
    status: typeof r.status === 'string' ? safeStatus(r.status) : r.status,
  }
}
