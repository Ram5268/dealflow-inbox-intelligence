// Brief 41 (H9), Brief 41.1: estate, probate, divorce, a death, illness, age and
// similar personal circumstances are never stored or shown. The extractors don't
// ask for them, and anything a model returns anyway is dropped here before
// saving (a motivation or status entirely; any sentence or line of a title,
// summary or reason that mentions one).
//
// Each check runs on one sentence at a time with its whitespace collapsed, and
// every quantifier inside a lookbehind or lookahead is bounded, so the checks
// stay linear on every regex engine (CI's Node 22 was quadratic on an unbounded
// one).

// "Passed" is a death unless what follows makes it ordinary, and only in a
// deal or building context. Anyone can pass on (or over) an offer, or pass a
// check ("passed on our offer", "passed the co-op board interview"). An owner,
// seller, landlord, he or she can also pass on a property, pass up, pass at
// asking, pass for now, pass by the property, or pass the keys, a lead or the
// listing along to us; a relative can't ("Her mother passed her the house").
// Never when it goes to the family ("passed on the house to her", "passed
// title to his son"). Covers "passes", "passing" and "may pass", a word or an
// aside before the verb ("The owner, John Smith, sadly passed"), and the end
// of a line ("Owner passed\nThree units.").
const DET = 'the|a|an|our|their|his|her|its|my|your|this|that|these|those|both|all|every|each|any|several|multiple|two|three|four|five'
const ADJ = 'first|second|third|last|latest|new|initial|final|best|highest|higher|lower|lowest|low|high|lowball|strong|weak|cash|all-cash|verbal|written|full|full-price|asking|above-asking|over-asking|below-asking|counter|competing|backup|back-up|other|another|same|one|original|revised|current|previous|\\$?\\d[\\d,.]{0,12}[km]?'
// What someone passes on: a deal or a property. Never "this/that/one" ("passed
// on that very day"), "us" ("passed on us") or "it" followed by when or how it
// happened ("passed on it in her sleep").
const DEAL = "offers?|bids?|deals?|price|terms|propert(?:y|ies)|house|homes?|buildings?|listings?|units?|apartments?|place|contracts?|counter-?offers?|proposals?|opportunit(?:y|ies)|chance|buyers?|showings?|leases?|renewals?|financing|loans?|mortgages?|rates?|studios?|condos?|co-?ops?|townhouses?|brownstones?|lofts?|duplex(?:es)?|triplex(?:es)?|lots?|parcels?|spaces?|portfolio|package|\\d{1,3}\\s{0,2}-?(?:br|bd|bed(?:room)?s?|family)|(?:it|them)(?!\\s{1,3}(?:in|at|on|last|this|that|during|after|before|while|peacefully|suddenly|quietly|overnight|yesterday|today)\\b)|(?:buying|selling|renting|renewing|signing|bidding|countering|offering|making|moving|listing|accepting)\\b"
// What a relative passes on: only an offer.
const OFFER = 'offers?|bids?|deals?|price|terms|contracts?|counter-?offers?|proposals?|opportunit(?:y|ies)|chance|(?:buying|selling|renting|renewing|signing|bidding|countering|offering|making|listing|accepting)\\b'
const CHECK_NO_TITLE = 'boards?|inspections?|appraisals?|background\\s{1,3}checks?|credit\\s{1,3}checks?|reviews?|interviews?|tests?|exams?|bar|approvals?|walk-?throughs?|underwriting|muster|requirements?|screenings?|votes?'
// Things handed over in a deal, never the property itself.
const HANDOFF = 'keys?|info(?:rmation)?|leads?|referrals?|listings?|numbers?|messages?|notes?|details|word|contacts?|emails?|files?|paperwork|documents?|docs|forms?|floor\\s{1,3}plans?|photos?|pictures?|brochures?|disclosures?|offers?|bids?'
// …and never to the family: "passed on the house to her", "to the kids".
const NOT_TO_FAMILY = "(?!(?:\\s{1,3}[\\w'’-]{1,40}){0,4}?\\s{1,3}to\\s{1,3}(?:her|him|them|his|their|my|our|the\\s{1,3}(?:kids|children|family))\\b)"
const ON_A_DEAL = `\\s{1,3}(?:on|over)\\s{1,3}(?:(?:${DET}|${ADJ})\\s{1,3}){0,3}(?:${DEAL})\\b${NOT_TO_FAMILY}`
const ON_AN_OFFER = `\\s{1,3}(?:on|over)\\s{1,3}(?:(?:${DET}|${ADJ})\\s{1,3}){0,3}(?:${OFFER})\\b${NOT_TO_FAMILY}`
const CHECK_WORD = "(?:(?:co-?op|condo|building|final|city|home|driving|driver['’]?s|road|licensing|state|real\\s{1,3}estate)\\s{1,3})?"
const A_CHECK = `\\s{1,3}(?:(?:${DET})\\s{1,3})?${CHECK_WORD}(?:${CHECK_NO_TITLE}|title)\\b${NOT_TO_FAMILY}`
const A_CHECK_NO_TITLE = `\\s{1,3}(?:(?:${DET})\\s{1,3})?${CHECK_WORD}(?:${CHECK_NO_TITLE})\\b${NOT_TO_FAMILY}`
const OWNER_ORDINARY = [
  ON_A_DEAL,
  A_CHECK,
  '\\s{1,3}up\\b',
  '\\s{1,3}(?:by|through)\\s{1,3}(?:(?:the|a|an|our|my|his|her|their)\\s{1,3})?(?:property|house|home|building|unit|apartment|office|site|block|lot|open\\s{1,3}house|neighborhood|area|town|street|listing|showing)\\b',
  `\\s{1,3}(?:along|over)\\s{1,3}(?:(?:the|a|an|our|my|his|her|their)\\s{1,3})?(?:${HANDOFF})\\b${NOT_TO_FAMILY}`,
  `\\s{1,3}(?:(?:${DET})\\s{1,3})?(?:${HANDOFF})\\s{1,3}(?:along|on|over|to)\\b${NOT_TO_FAMILY}(?!\\s{1,3}(?:her|him|them|his|their)\\b)`,
  '\\s{1,3}(?:it|them|this|that)\\s{1,3}along\\s{1,3}to\\s{1,3}(?:me|us|you|(?:her|his|their|my|our|the)\\s{1,3}(?:attorney|lawyer|agent|broker|colleague|assistant|manager|office|team|accountant))\\b',
  `\\s{1,3}(?:me|us|him|her|them)\\s{1,3}(?:(?:the|a|an|his|her|their|our|my)\\s{1,3})?(?:${HANDOFF})\\b`,
  '\\s{1,3}at\\s{1,3}(?:\\$|asking\\b|full\\s{1,3}price\\b|\\d[\\d,.]{0,12}\\s{0,2}(?:k|m|mm|million)\\b)',
  '\\s{1,3}for\\s{1,3}(?:now|the\\s{1,3}time\\s{1,3}being)\\b',
  '\\s{1,3}this\\s{1,3}time(?!\\s{1,3}(?:last|next|of|around|a|in|two|three|\\d))\\b',
  '\\s{1,3}because\\s{1,3}(?:the|our|their|of\\s{1,3}the)\\s{1,3}(?:price|offer|bid|terms|numbers?|valuation|appraisal|commission)\\b',
  // "passed, not interested" (in selling, at that price); "no thanks" only
  // when it ends the clause ("no thanks to her doctors" isn't declining).
  '\\s{0,3}[,:;—–-]{1,3}\\s{0,3}(?:not\\s{1,3}interested(?=\\s{0,3}(?:[.!?;)]|$)|\\s{1,3}(?:in\\s{1,3}(?:selling|listing|moving|offers?|(?:the|our|your|any)\\s{1,3}offers?|it)|at\\s{1,3}(?:that|this|the|any)\\s{1,3}price)\\b)|no\\s{1,3}thanks(?=\\s{0,3}(?:[.!?;)]|$)))',
].join('|')
const RELATIVE_ORDINARY = [ON_AN_OFFER, A_CHECK_NO_TITLE].join('|')
const RELATIVE = '(?:mother|father|mom|dad|husband|wife|spouse|parents?|grand(?:mother|father|ma|pa|parents?)|aunt|uncle|brother|sister|son|daughter)'
const BEFORE_PASSING = 'has|had|have|is|was|will|may|might|could|would|about|to|going|expected|likely|soon|now|recently|just|very|sadly|suddenly|unexpectedly|unfortunately|tragically|both|all|also|since|and|then|finally|peacefully|quietly|apparently|reportedly|already'
const ASIDE = ",\\s*(?:[\\w.'’-]+\\s+){0,3}[\\w.'’-]+\\s*,"
const PASSES = `(?:\\s*${ASIDE})?\\s+(?:(?:${BEFORE_PASSING})\\s+){0,4}pass(?:ed|es|ing)?\\b`
const OWNER_PASSES = `(?:owners?|sellers?|homeowners?|landlords?|he|she|who|(?:mr|mrs|ms|miss|dr)\\.?(?:\\s+[a-z]+){1,2})${PASSES}(?!${OWNER_ORDINARY})`
const RELATIVE_PASSES = `(?:partners?|${RELATIVE})${PASSES}(?!${RELATIVE_ORDINARY})`
const PERSON = `(?:owners?|sellers?|homeowners?|landlords?|partner|child|children|${RELATIVE}|(?:mr|mrs|ms|miss|dr)\\b)`
// Someone whose age or health is theirs: never a building (so not "they":
// "They are 100 years old" is usually the houses).
const SOMEONE = `(?:owners?|sellers?|homeowners?|landlords?|he|she|couple|widow\\w*|${RELATIVE})`

// "Separating" or "splitting up" is a couple's only when nothing it acts on
// follows: "the Smiths are separating" vs "the owner is separating the lots".
const SEP_OBJECT = '\\s{1,3}(?:the|a|an|this|that|these|those|its|two|three|four|five|both|each|all|\\d+|lots?|units?|parcels?|propert(?:y|ies)|buildings?|apartments?|meters?|utilities|spaces?|rooms?|floors?|kitchens?|bedrooms?|entrances?|walls?|fences?|doors?|lines?|partitions?)\\b|\\s{1,3}(?:from\\s{1,3}(?:the|a|an|its|unit|apartment|apt|floor|room)|into)\\b'
const SPLIT_OBJECT = '\\s{1,3}(?:the|a|an|this|that|these|those|its|it|them|everything|two|three|four|five|\\d+|lots?|units?|parcels?|propert(?:y|ies)|buildings?|apartments?|floors?|space|rooms?|evenly|equally|half|proceeds|costs?|commission|fees?|rent|bills?)\\b|\\s{1,3}into\\b'
// "is", "are", "was", "were", also "she's" or "they're".
const IS = "(?:\\s+(?:is|are|was|were)|['’](?:s|re))"
// Ages that are a count of something else: "the owner is 20 minutes away".
const NOT_AN_AGE = '(?![\\d/%]|[.,]\\d|\\s{0,3}(?:units?|feet|ft|sq|square|percent|famil(?:y|ies)|beds?|bedrooms?|baths?|minutes?|mins?|blocks?|days?|weeks?|months?|stories|storeys|floors?|miles?|k\\b|m\\b))'

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
    `(?:couple|spouses?|they|we|owners)\\s+(?:(?:have|had|recently|just|finally)\\s+){0,2}split\\b(?!\\s{1,3}up)(?!${SPLIT_OBJECT})`,
    'break[\\s-]?ups?(?!\\s{1,3}(?:fees?|value|clause))', '(?:couple|spouses?|they|we)\\s+(?:(?:are|is|was|were|have|had)\\s+)?part(?:ing|ed)\\s+ways',
    'no\\s+longer\\s+together', '(?:husband|wife|spouse|partner)\\s+(?:(?:has|had|recently|just)\\s+)?moved\\s+out',
    'marriage\\s+(?:ended|is\\s+over|was\\s+over|fell\\s+apart|broke\\s+down|counsel\\w*|troubles?|problems?)', '(?:failed|failing|broken|ended|troubled|rocky)\\s+marriage',
    'family\\s+court', 'equitable\\s+distribution', 'restraining\\s+order', 'domestic\\s+(?:violence|abuse)', 'orders?\\s+of\\s+protection',
    'family\\s+(?:reasons|issues|matters|problems|emergenc(?:y|ies)|tragedy|crisis)',
    // A death, an estate, an inheritance
    'pass(?:ed|es|ing)?\\s+away', '(?:his|her|their)\\s+passing', "\\w+['’]s\\s+passing(?!\\s{1,3}(?:grade|score|mark|lane|traffic))",
    `passing\\s+of\\s+(?:(?:the|his|her|their|my|our|a|an)\\s+)?(?:late\\s+)?${PERSON}`,
    'bereave\\w*', 'letters\\s+testamentary', 'letters?\\s+of\\s+administration', "surrogate(?:['’]s|s)?\\s+court",
    'decedents?', 'intestate', 'obituar(?:y|ies)', '(?:passed|handed)\\s+down', 'no\\s+longer\\s+(?:alive|with\\s+us)',
    'no\\s+longer\\s+living(?!\\s{1,3}(?:there|here|in|at|on|upstairs|downstairs|nearby|locally))',
    'surviving\\s+(?:spouse|husband|wife|partner|children|kids|sons?|daughters?|family|heirs?|siblings?|relatives?)', 'survived\\s+by',
    'beneficiar(?:y|ies)', 'next\\s+of\\s+kin', '(?:per|in|under|by)\\s+(?:the|his|her|their|my)\\s+(?:last\\s+)?will(?!\\s{1,3}(?:of|be|not|to))',
    'griev(?:e|es|ed|ing)', 'grief', 'mourn(?:s|ed|ing)?', 'condolences?', 'sorry\\s+for\\s+(?:your|their|his|her|the)\\s+loss',
    'suicide', '(?:was|were|been|got)\\s+killed', 'killed\\s+(?:in|by|during)\\s+(?:a|an|the)', 'succumb\\w*', 'est\\.?\\s+of\\s+(?!\\d)',
    'guardianship', 'conservators?', 'conservatorship', 'court[\\s-]+appointed\\s+(?:guardian|conservator)s?', 'appointed\\s+(?:a\\s+)?(?:guardian|conservator)',
    'power\\s+of\\s+attorney', 'poa', 'incapacit\\w*', 'lacks?\\s+(?:mental\\s+)?capacity',
    `(?:late|deceased)\\s+(?:husband|wife|spouse|mother|father|mom|dad|parents?|owners?|grand(?:mother|father|ma|pa)|(?:mr|mrs|ms|miss|dr)\\b)`,
    OWNER_PASSES, RELATIVE_PASSES,
    `(?:owners?|sellers?|homeowners?|landlords?|he|she|partners?|${RELATIVE})\\s+(?:(?:has|had|sadly|recently|just|suddenly)\\s+){0,2}left\\s+us(?!\\s{1,3}(?:(?:a|an|the|some|his|her|their|our|its|this|that|these|those|two|three|several|\\d{1,3})\\s{1,3}){0,2}(?:keys?|messages?|voicemails?|notes?|word|instructions|details|info\\w{0,10}|numbers?|emails?|texts?|calls?|reviews?|feedback|offers?|deposits?|checks?|documents?|paperwork|photos?|forms?|cop(?:y|ies)|contracts?|sets?)\\b)`,
    'lost\\s+(?:his|her|their|a)\\s+(?:husband|wife|spouse|partner|mother|father|mom|dad|parents?|son|daughter|child|baby|life|lives|battle)',
    'deceased', 'deaths?', 'deathbeds?', 'died', 'dies', 'dying', 'dead', 'funeral', 'widow\\w*',
    'heirs?', 'inherit\\w*', 'executors?', 'co-executors?', 'executrix', 'administratrix', 'estates?',
    // Illness, disability and care
    '(?:terminally|seriously|chronically|very|gravely|critically|severely)\\s+ill(?!-)', 'terminally', '(?:is|are|was|became|being)\\s+terminal',
    '(?:is|was|are|were|been|got|gets|getting|became|become|becomes|being|fell|falls)\\s+ill(?!-)', 'illness(?:es)?', 'unwell',
    'sick(?:ly|ness|er)?', '(?:poor|failing|declining|bad|frail|fragile|deteriorating|ill)[\\s-]+health', 'frail(?:ty)?',
    '(?:health|medical)\\s+(?:issues?|problems?|reasons?|conditions?|concerns?|scares?|crisis|decline|emergenc(?:y|ies)|bills?|treatments?)',
    'terminal(?:ly)?\\s+(?:ill\\w*|diagnos\\w*|cancer|conditions?|disease|prognosis)', 'diagnosed\\s+with',
    'not\\s+expected\\s+to\\s+(?:live|survive|make\\s+it|recover|last)', '(?:days|weeks|months|years)\\s+(?:left\\s+)?to\\s+live(?!\\s{1,3}(?:(?:in|at)\\s{1,3}(?:the|her|his|their|its|a|an)\\s{1,3}(?:house|home|unit|apartment|property|place|condo|co-?op|building)\\b|(?:there|here|upstairs|downstairs)\\s{1,3}(?:under|until|through|after|before|per|rent)\\b))', 'long\\s+to\\s+live',
    'end[\\s-]+of[\\s-]+life', 'life\\s+support', '(?:in|into|out\\s+of)\\s+(?:a\\s+)?coma', 'comatose', 'in\\s+(?:critical|grave)\\s+condition',
    'undergoing\\s+(?:\\w+\\s+)?(?:treatments?|therapy|chemo\\w*|dialysis|surgery)',
    'strokes?', 'hospitali[sz](?:ed|ation|ations)', 'surger(?:y|ies)', 'injured', 'bed-?ridden', 'housebound', 'homebound',
    '(?:in|into|out\\s+of|admitted\\s+to|rushed\\s+to|taken\\s+to|went\\s+to|discharged\\s+from|released\\s+from)\\s+(?:(?:the|a)\\s+)?hospitals?(?!\\s{1,3}(?:district|zone|area|corridor|campus|buildings?|complex|center|centre|grade|parking))',
    'intensive\\s+care', 'icu', 'chemo(?:therapy)?', 'radiation\\s+(?:therapy|treatments?)', 'dialysis', 'palliative', 'hospice',
    'cancer', 'tumou?rs?', 'leukemia', 'lymphoma', 'multiple\\s+sclerosis', 'parkinson\\w*', 'alzheimer\\w*', 'dementia',
    'memory\\s+loss', 'cognitive\\s+(?:decline|impairment|issues?|problems?)', 'senil\\w*',
    'heart\\s+(?:attack|failure|condition|surgery|disease|problems?)', 'disabilit(?:y|ies)',
    `${SOMEONE}(?:${IS}|\\s+became|\\s+has\\s+been)\\s+(?:(?:now|permanently|severely|very)\\s+)?(?:disabled|depressed)`,
    'disabled\\s+(?:owners?|sellers?|homeowners?|landlords?|veterans?|mother|father|son|daughter|husband|wife|parents?)',
    '(?:has|with|suffers\\s+from|battling|struggling\\s+with)\\s+depression', '(?:uses|using|in|needs|confined\\s+to)\\s+a\\s+wheelchair',
    'care\\s+for\\s+(?:her|him|them)', `${SOMEONE}\\s+needs?\\s+care`,
    'needs?\\s+(?:(?:full|part)[\\s-]time|long[\\s-]term|constant|round[\\s-]the[\\s-]clock|24[\\s/-]7|nursing|medical|home)\\s+care',
    `${SOMEONE}${IS}\\s+in\\s+rehab`, `${SOMEONE}${IS}\\s+(?:in|at)\\s+(?:a|an|the)\\s+(?:medical|rehab(?:ilitation)?|care)\\s+(?:facilit(?:y|ies)|centers?|centres?|units?)`,
    `${SOMEONE}\\s+(?:has|had|with)\\s+(?:als|ms|copd|hiv|aids)`, 'memory[\\s-]+care', 'care[\\s-]+(?:homes?|facilit(?:y|ies))', 'caregivers?', 'home[\\s-]+health',
    'nursing[\\s-]+homes?', 'assisted[\\s-]+living', 'skilled\\s+nursing', 'long[\\s-]+term\\s+care',
    '(?:moving|moved|move|going|gone|went|relocating)\\s+(?:in)?to\\s+(?:(?:a|an)\\s+)?(?:senior\\s+(?:living|housing|residences?|homes?|communit(?:y|ies))|retirement\\s+(?:homes?|communit(?:y|ies)|villages?|facilit(?:y|ies)))',
    // Age (a demographic)
    'elderly', '(?:aging|ageing|aged|older)\\s+(?:owners?|sellers?|homeowners?|landlords?|parents?|mother|father|mom|dad|couple|man|woman|lady|gentleman|widow\\w*|relatives?)',
    'old\\s+(?:man|woman|lady|gentleman|couple)', 'retirees?',
    'retired\\s+(?:couple|owners?|sellers?|homeowners?|landlords?|parents?|widow\\w*|man|woman|lady|gentleman)',
    `${SOMEONE}${IS}\\s+(?:(?:now|recently|already)\\s+)?retired`, '(?:octo|nona|septua|sexa)genarians?', 'getting\\s+on\\s+in\\s+years',
    'seniors?\\s+(?:citizens?|owners?|homeowners?|sellers?|landlords?|couple|selling|downsizing)',
    `${SOMEONE}${IS}\\s+(?:a\\s+)?seniors?(?!\\s{1,3}(?:partner|vice|executive|manager|director|officer|associate|analyst|engineer|loan|broker|agent|vp|counsel|member|editor|consultant|advis[eo]r|designer|developer|architect|scientist|attorney|lawyer|accountant))`,
    `${SOMEONE}${IS}\\s+(?:(?:getting|too|very|quite|so)\\s+)?old(?:er)?`,
    `${SOMEONE}${IS}\\s+(?:(?:now|about|nearly|almost|over|around|past|pushing|aged?)\\s+)?\\d{2,3}${NOT_AN_AGE}`,
    `${SOMEONE}\\s*,\\s*(?:age\\s+|aged\\s+)?\\d{2,3}(?=\\s{0,3},)`,
    '\\d{2,3}[\\s-]+years?[\\s-]+old\\s+(?:owners?|sellers?|homeowners?|landlords?|mother|father|man|woman|lady|gentleman|widow\\w*|parents?|couple)',
    "in\\s+(?:his|her|their)\\s+(?:early\\s+|mid[\\s-]?|late\\s+)?(?:[2-9]0['’]?s|twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)",
  ]
    .map((p) => `\\b(?:${p})\\b`)
    .join('|'),
  'i',
)

// Ordinary phrases that contain those words, removed before the check. Each is
// narrow and tied to a building, listing or deal. The groups below the first
// are switched off in a sentence that is about a person (their family, their
// care, their body): over-dropping a sentence is fine, a leak isn't.
const phrases = (list: string[]) => new RegExp(list.map((p) => `\\b(?:${p})\\b`).join('|'), 'gi')

// Idioms and building words, whoever the sentence is about.
const ALWAYS_ORDINARY = phrases([
  'real[\\s-]+estates?', 'estate[\\s-]+(?:agents?|sized|style)', 'jamaica\\s+estates',
  '(?<=\\w\\s{1,3})estates\\s+(?:condo|co-?op|building|development)s?', // only "estates co-op": the word before is still checked
  'dead[\\s-]+end', 'dead[\\s-]?bolts?', 'death[\\s-]+defying', 'dead[\\s-]+(?:set|space|rent|trees?|plants?|grass|lawn|leaves|zones?|spots?)',
  'drop[\\s-]*dead(?=[\\s-]{1,3}(?:gorgeous|views?|skyline|vistas?|location|date|deadline|kitchen|terrace|rooftop|roof|light|finishes|design|layout|unit|apartment|home|house|brownstone|townhouse|condo|penthouse|garden|backyard|yard|space)\\b)',
  'died\\s+down', 'dying\\s+to', 'ill[\\s-]+(?:fated|advised)', "widow['’]?s[\\s-]+walks?",
  'sick\\s+(?:and\\s+tired\\s+)?of', 'sick\\s+building(?:\\s+syndrome)?', 'strokes?\\s+of\\s+(?:luck|genius|good\\s+(?:luck|fortune)|midnight)', '(?:brush|pen|key|master)[\\s-]?strokes?',
  '(?:building|property|roof|boiler|market|economy|block|structure)\\s+(?:is\\s+|was\\s+)?in\\s+(?:poor|failing|good|bad|great|fine)\\s+health',
])

// The building's condition, not a person's (round 4 review). Off when the sentence is about someone
// ("Her father is on life support systems", "The roof is end-of-life, and so is the owner").
const THING_CONDITION = phrases([
  '(?:building|property|roof|boiler|furnace|heater|hvac|systems?|equipment|elevators?|appliances?|windows?|facade|façade|foundation|plumbing|wiring|chimney|deck|porch|stairs?|structure)(?:[\'’]s)?\\s+(?:is|are|was|were)\\s+(?:(?:now|already|nearly|near|at|the|its|their)\\s+){0,3}(?:end[\\s-]+of[\\s-]+life|in\\s+(?:critical|grave)\\s+condition)',
  'life\\s+support\\s+systems?', 'long\\s+to\\s+live(?=\\s{1,3}(?:in|there|here|at|on|with)\\b)',
])

// A nursing or funeral home, an assisted living or a medical center as a
// building or a business ("across from a nursing home", "former funeral home",
// "nursing home for sale", "dialysis center tenant"); disability access and a
// home health agency as building uses. Off for a person's own care (below).
const BUILDING_TYPE = '(?:(?:nursing|funeral|care)[\\s-]+homes?\\b|assisted[\\s-]+living(?:\\s+facilit(?:y|ies)\\b|(?!\\s{1,3}facilit)))'
const NOT_SOMEONES_PLACE = '(?<!\\b(?:lives?|living|lived|moved?|moving|stays?|staying|stayed|visits?|visiting|visited|goes|going|went|be|been)\\s{1,3}(?:right\\s{1,3}|just\\s{1,3})?)'
const NOT_WHERE_SOMEONE_IS = "(?![\\s,;:—–-]{1,4}(?:where|in\\s{1,3}which|with|for|to\\s{1,3}(?:be|visit|see|stay)|so\\s{1,3}(?:she|he|they))\\b)"
const CARE_PLACES = phrases([
  `${NOT_SOMEONES_PLACE}(?:across\\s+(?:the\\s+street\\s+)?from|next\\s+(?:door\\s+)?to|near(?:by)?|beside|behind|adjacent\\s+to|opposite|former(?:ly)?|converted|vacant|abandoned|closed|shuttered)\\s+(?:(?:a|an|the)\\s+)?(?:former\\s+)?${BUILDING_TYPE}${NOT_WHERE_SOMEONE_IS}`,
  `${BUILDING_TYPE}(?:\\s+(?:building|facility|facilities|property))?\\s+(?:for\\s+(?:sale|lease|rent)(?!\\s{1,3}(?:support|assistance|help|subsid\\w{0,10}|relief))|conversions?|zoning|sites?|parcels?|lots?|use|operators?|business)`,
  `${BUILDING_TYPE}\\s+(?:(?:building|property)\\s+on\\s+the\\s+(?:ground|first|second|third|top)\\s+floor|tenants?)`,
  `(?:mixed[\\s-]use|building|property|storefront|retail(?:\\s+space)?)\\s+(?:with|has|houses|includes)\\s+(?:(?:a|an|the)\\s+)?${BUILDING_TYPE}(?:\\s+(?:tenant|business))?\\s+on\\s+the\\s+(?:ground|first|second|third|top)\\s+floor`,
  '(?:dialysis|surgery|surgical|urgent[\\s-]+care|day[\\s-]+care|child[\\s-]+care|medical|chemo(?:therapy)?|cancer|rehab|physical\\s+therapy)\\s+(?:centers?|centres?|clinics?|offices?|practices?|suites?|facilit(?:y|ies))\\s+(?:tenants?|for\\s+(?:sale|lease|rent)|space|use)',
  'disabilit(?:y|ies)\\s+(?:access(?:ible|ibility)?|ramps?|compliant|compliance|friendly|parking|bathrooms?|entrances?|lifts?|elevators?)',
  'home[\\s-]+health\\s+(?:agency|agencies|company|companies|offices?|business|providers?)',
])
// Things that died or are dead ("the deal is dead", "the boiler died"); in
// DealFlow a "lead" is a person, so never a lead. Off when the sentence is
// about someone ("The listing died in March, as did the owner").
const DEAD_THING = '(?:deal|listing|sale|contract|offer|bid|escrow|financing|loan|mortgage|application|project|negotiations?|transaction|(?:1031\\s+)?exchange|market|heater|boiler|furnace|batter(?:y|ies)|roof|trees?|plants?|grass|lawn|engine|compressor|elevator|motor|pump|hvac|phone|car|signal|wifi|internet|momentum|buzz)'
const DEAD_THINGS = phrases([
  `${DEAD_THING}s?\\s+(?:(?:is|was|has|had|have|just|basically|now|already|then|seems|looks|looked|went|totally|completely)\\s+){0,2}(?:died|dead|dies|dying)(?![\\s,;:—–-]{1,4}(?:with|along|and|as|like|after|when|the\\s{1,3}day|together|alongside|too|also|so|then)\\b)`,
])
// Custody of the keys or the escrow, never of anyone. Off when the sentence is about someone.
const CUSTODY_OF_THINGS = phrases(['(?:escrow|bank|deposit|securities|key|keys)\\s+custody', 'custody\\s+of\\s+(?:the\\s+)?(?:keys|deposit|funds|escrow|documents|files)'])
// A buyer, purchaser or "you" inherits the tenants or the lease ("Inherit the
// tenants." too). Off when the sentence names family ("Her son becomes the new
// owner; inherits the tenants").
const INHERITED_LEASES = phrases([
  "(?:(?:buyers?|purchasers?|you(?:['’]ll)?|investors?|(?:the\\s+)?new\\s+owners?)\\s+(?:(?:will|would|could|can|may|might|must|also|then|both|automatically|simply)\\s+){0,2}|(?<=^|[.!?]\\s{0,3}))inherits?\\s+(?:(?:the|a|an|all|any|two|three|four|five|six|\\d+|existing|current|in-place|rent[\\s-]stabilized|rent[\\s-]controlled|stabilized|regulated|long[\\s-]term|paying|good|great|its|occupied|residential|commercial)\\s+){0,3}(?:tenants?|tenancy|tenancies|leases?)",
])
// Separated or split-up rooms, lots and units. Off when the sentence is about a couple.
const SEPARATE_THING = '(?:bedrooms?|rooms?|lots?|units?|apartments?|apts?|floors?|meters?|utilities|gas|electric(?:ity)?|kitchens?|baths?|bathrooms?|entrances?|buildings?|parcels?|spaces?|garages?|yards?|wings?|sections?|stairs?|halls?|duplex(?:es)?|living\\s+(?:rooms?|areas?)|dining\\s+(?:rooms?|areas?))'
const SEPARATE_THINGS = phrases([
  'separated\\s+by\\s+(?:(?:a|an|the|\\d+)\\s+)?(?:[\\w-]+\\s+)?(?:courtyards?|yards?|gardens?|walls?|fences?|hallways?|halls?|driveways?|streets?|alleys?|alleyways?|walkways?|breezeways?|lobb(?:y|ies)|stair(?:case|well)?s?|lots?|feet|ft|foot|blocks?|buildings?|garages?|patios?|terraces?|partitions?|doors?|floors?|landings?|corridors?)',
  `${SEPARATE_THING}(?:\\s+(?:\\d+[a-z]?|[a-z]))?\\s+(?:are|is|were|was|can\\s+be|will\\s+be|have\\s+been|has\\s+been)\\s+(?:(?:fully|completely|physically|well)\\s+)?separated`,
  "(?:lots?|units?|parcels?|propert(?:y|ies)|buildings?|space|apartments?|floors?|rooms?|portfolio|proceeds|commission)\\s+(?:(?:can|could|can['’]t|cannot|couldn['’]t|may|might|will|won['’]t|would|wouldn['’]t|should|must|to|not|be|been|being|is|are|was|were|easily|legally|never|already|also)\\s+){0,4}split\\s+up",
])

// What makes a sentence about a person, for the groups above.
const NAMES_FAMILY = new RegExp(`(?:\\b(?:step-?|god)?(?:${RELATIVE}s?)(?:-in-laws?)?\\b|\\b(?:wives|partners?|mum|in-laws?|nephews?|nieces?|cousins?|siblings?|fianc[eé]e?s?|boyfriends?|girlfriends?|grand(?:sons?|daughters?|kids?|children)|widow\\w*)\\b)`, 'i')
const CARE_CONTEXT = /\b(?:lives?|(?<!assisted[\s-])living(?!\s{1,3}(?:rooms?|areas?|spaces?|quarters))|lived|resides?|residing|resided|moved?|moving|stays?|staying|stayed|admitted|treated|treatments?|visits?|visiting|visited|cares?\s+for|caring\s+for|cared\s+for|going\s+into|go(?:es)?\s+into|went\s+into|placed\s+in|placement|aides?|nurses?|caregivers?|caretakers?|to\s+be\s+(?:close|near)|so\s+(?:she|he|they)\s+can)\b/i
const PERSON_NEEDS = /\b(?:owners?|sellers?|homeowners?|landlords?|he|she|they)\s+(?:(?:also|now|really|still|will|would|may|might|does|do|did|doesn['’]t|don['’]t|can|could)\s+)?(?:needs?|uses?|using|requires?|gets?|getting|relies\s+on|depends\s+on|receives?)\b/i
const ABOUT_SOMEONE = /\b(?:owners?|sellers?|homeowners?|landlords?|he|she|him|her|his|hers|they|them|their|who|whom|kids|children|(?<!-)family|heirs?|killed|crash|accident|did\s+too|as\s+did|so\s+did)\b/i
// A person in the sentence for the care places: a pronoun, or an owner who is somewhere ("The owner is a nursing home tenant", not "The owner is selling a former funeral home").
const PERSON_HERE = /\b(?:he|she|him|her|his|hers|they|them|their|who|whom)\b|\b(?:owners?|sellers?|homeowners?|landlords?)\s(?:(?:is|was|are|were)\s(?:now\s|still\s)?(?:a|an|in|at|on)|spends?|sleeps?)\b/i
const HEIRS = /\b(?:kids|children|heirs?|family|siblings?)\b/i
// A death anywhere in the sentence ("…inherits the tenants when Jane passes").
const DEATH_WORD = /\b(?:pass(?:es|ed|ing)|died|dies|dying|deceased|deaths?|(?:is|was|are|were)\s(?:now\s)?gone|no\slonger\swith\sus)\b/i
const COUPLE = /\b(?:couples?|spouses?|husbands?|wife|wives|partners?|marriage|married)\b/i

// "<Name> Estates" is a place, so the word "Estates" there is ordinary, but
// only that word (the words before it are still checked: "Inherited Jamaica
// Estates colonial" is caught), and only where it reads as a place: after
// in/at/near/around/throughout/across, or before a home or place word
// ("Bayside Estates two-family", "Fieldston Estates colonial"). Never as a
// party ("Proceeds go to the Smith Estates", "Johnson Estates properties are
// being sold"), nor after "The/His/…". "Estates at <Place>" is a development.
const NAMED_ESTATES = /\b(?!(?:The|A|An|His|Her|Their|Its|Our|My|Your|This|That|These|Those|Both|All|Two|Three|Four|Five|Several|Many|Some|Any|No|Each|Every)\b)[A-Z][a-z]+(?:\s[A-Z][a-z]+)?\sEstates\b/g
const PLACE_BEFORE = /\b(?:in|at|near|around|throughout|across)\s(?:the\s)?$/i
// "in the <Name> Estates" is a place only in a sentence about a home ("Homes in
// Fresh Meadows Estates are pricey", not "Money is tied up in the Smith Estates").
const HOME_WORD = /\b(?:homes?|houses?|condos?|co-?ops?|units?|apartments?|apts?|propert(?:y|ies)|listings?|lots?|parcels?|townhouses?|brownstones?|colonials?|tudors?|ranch(?:es)?|single[\s-]famil(?:y|ies)|(?:one|two|three|four|multi)[\s-]famil(?:y|ies)|buildings?|located|neighborhood|area)\b/i
// "a stake / an interest / a share in the Smith Estates" is a party, not a place.
const STAKE_BEFORE = /\b(?:stakes?|interests?|shares?|claims?|part|portion|beneficiar\w{0,6}|rights?)\s(?:in|at)\s(?:the\s)?$/i
const PLACE_AFTER = /^\s(?:(?:one|two|three|four|1|2|3|4|multi|single)[\s-]famil(?:y|ies)|co-?ops?|condos?|condominiums?|homes?|houses?|colonials?|tudors?|capes?|ranch(?:es)?|split[\s-]levels?|brownstones?|townhouses?|town\shomes?|row\s?houses?|units?|apartments?|apts?|section|neighborhood|area|development|community|complex|detached|semi[\s-]detached|brick)\b/i
const ESTATES_AT_PLACE = /\bEstates\sat\s(?=[A-Z])/g
function withoutPlaceEstates(text: string): string {
  return text
    .replace(NAMED_ESTATES, (m: string, offset: number) =>
      (PLACE_BEFORE.test(text.slice(Math.max(0, offset - 16), offset)) && !STAKE_BEFORE.test(text.slice(Math.max(0, offset - 30), offset)) && HOME_WORD.test(text) && /^(?:\s*$|\s*[.!?]|,\s(?:Queens|Brooklyn|Bronx|Manhattan|Staten\sIsland|Long\sIsland|NY|New\sYork))/.test(text.slice(offset + m.length, offset + m.length + 20))) || PLACE_AFTER.test(text.slice(offset + m.length, offset + m.length + 40))
        ? m.replace(/Estates$/, ' ')
        : m,
    )
    .replace(ESTATES_AT_PLACE, ' ')
}
// "Owner Jane Smith passed in March": the name between the owner and the verb.
const OWNER_NAME = /\b((?:[Oo]wners?|[Ss]ellers?|[Hh]omeowners?|[Ll]andlords?)\s)(?:(?:Mr|Mrs|Ms|Dr)\.?\s)?(?:[A-Z][a-z'’-]{0,30}\s){1,3}(?=[Pp]ass)/g

// One sentence (whitespace collapsed) without its ordinary phrases.
function withoutOrdinaryPhrases(sentence: string): string {
  const s = withoutPlaceEstates(sentence.replace(/\s+/g, ' ').replace(OWNER_NAME, '$1'))
  const family = NAMES_FAMILY.test(s)
  const aboutSomeone = family || ABOUT_SOMEONE.test(s)
  let out = s.replace(ALWAYS_ORDINARY, ' ')
  if (!family && !PERSON_HERE.test(s) && !CARE_CONTEXT.test(s) && !PERSON_NEEDS.test(s)) out = out.replace(CARE_PLACES, ' ')
  if (!aboutSomeone) out = out.replace(DEAD_THINGS, ' ').replace(CUSTODY_OF_THINGS, ' ').replace(THING_CONDITION, ' ')
  if (!family && !HEIRS.test(s) && !DEATH_WORD.test(s)) out = out.replace(INHERITED_LEASES, ' ')
  if (!COUPLE.test(s)) out = out.replace(SEPARATE_THINGS, ' ')
  return out.replace(/\s+/g, ' ')
}

export function mentionsPersonalCircumstances(text: string | null | undefined): boolean {
  return !!text && PERSONAL.test(sentencesOf(text).map(withoutOrdinaryPhrases).join(' '))
}

// A motivation that mentions any of them is dropped entirely.
export function safeMotivation(motivation: string | null | undefined): string | null {
  const m = motivation?.trim()
  return m && !mentionsPersonalCircumstances(m) ? m : null
}

// Free text is checked a line and a sentence at a time; each is kept or dropped
// whole. A line that carries on the sentence before it (no end mark before the
// break, the next line starts in lowercase: "She passed\naway last year.")
// joins it; a blank line ends a paragraph. A sentence ends at . ! or ? (not
// after Mr./Dr./St. …), also when the next one follows with no space
// ("list.Divorce"), but never inside a web address or an email
// ("www.Example.com", "jane.Doe@example.com"). Semicolons and dashes don't
// split: a sentence with any sensitive clause is dropped whole ("Divorce
// pending; wife keeps the house").
const ABBREVIATION = '(?:Mr|Mrs|Ms|Dr|St|Ave|Jr|Sr|Apt|No|Prof|Rev|Hon|Sgt|Capt|Lt|Col|Gen)'
const SENTENCE_BREAK = new RegExp(
  [
    `(?<=(?<!\\b${ABBREVIATION})[.!?]["')\\]]?)\\s+`,
    `(?<=(?:^|[\\s("'\\[])[A-Za-z]{2,30}[.!?])(?<!(?:^|[\\s("'\\[])${ABBREVIATION}[.!?])(?=[A-Z][a-z]{0,40}(?:[\\s,;:!?)"']|[.!?](?:\\s|$)|$))`,
  ].join('|'),
)
const ENDS_SENTENCE = new Set(['.', '!', '?', ':', ';', '"', "'", ')', ']'])
const STARTS_LOWERCASE = /^[a-z]/

function linesOf(text: string): string[] {
  const lines: string[][] = []
  let lastEnded = true
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) {
      lastEnded = true // a blank line ends a paragraph
      continue
    }
    if (!lastEnded && STARTS_LOWERCASE.test(line)) lines[lines.length - 1].push(line)
    else lines.push([line])
    lastEnded = ENDS_SENTENCE.has(line[line.length - 1])
  }
  return lines.map((parts) => parts.join(' '))
}

function sentencesOf(text: string): string[] {
  return linesOf(text)
    .flatMap((line) => line.split(SENTENCE_BREAK))
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

// Free text without the sentences (or lines) that mention them. Unchanged text
// comes back as it was.
export function withoutPersonalCircumstances(text: string): string {
  if (!mentionsPersonalCircumstances(text)) return text
  const out = sentencesOf(text)
    .filter((sentence) => !mentionsPersonalCircumstances(sentence))
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
