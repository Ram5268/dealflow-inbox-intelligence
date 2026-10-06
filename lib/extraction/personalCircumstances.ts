// Brief 41 (H9): estate, probate, divorce, a death, illness and similar personal
// circumstances are never stored or shown. The seller-lead extractors no longer
// ask for them, and anything a model returns anyway is dropped here before
// saving (the motivation entirely; any sentence of a title, summary or reason
// that mentions one).
const PERSONAL = new RegExp(
  [
    'probat\\w*', 'divorc\\w*', 'ex-(?:wife|husband|spouse)', 'marital', 'separation agreement', 'legal\\s+separation',
    '(?:couple|spouses?|husband|wife|they|we)\\s+(?:are\\s+|is\\s+|have\\s+)?separat(?:ed|ing)',
    'passed\\s+away', '(?:his|her|their)\\s+passing', 'bereave\\w*', 'letters\\s+testamentary', "surrogate(?:['’]s|s)?\\s+court",
    '(?:late|deceased)\\s+(?:husband|wife|spouse|mother|father|mom|dad|parents?|owners?|grand(?:mother|father|ma|pa))',
    // A relative who passed or died; an owner who "passed" only when nothing
    // follows that makes it ordinary ("the owner passed in March" vs "the owner
    // passed on our offer").
    '(?:mother|father|mom|dad|husband|wife|spouse|parents?|grand(?:mother|father|ma|pa)|aunt|uncle|brother|sister|son|daughter)\\s+(?:has\\s+|had\\s+)?(?:passed|died)',
    'owners?\\s+(?:has\\s+|had\\s+|recently\\s+)?passed(?=\\s+(?:away|in|last|recently|earlier|suddenly)\\b|\\s*[.,;]|\\s*$)',
    'lost\\s+(?:his|her|their|a)\\s+(?:husband|wife|spouse|mother|father|mom|dad|parents?|son|daughter|child)',
    'deceased', 'deaths?', 'died', 'dies', 'dying', 'dead', 'funeral', 'widow\\w*',
    'heirs?', 'inherit\\w*', 'executors?', 'co-executors?', 'executrix', 'estates?',
    '(?:terminally|seriously|chronically|very)\\s+ill(?!-)', '(?:is|was|are|were|been|got|gets|getting|became|become|becomes|being|fell|falls)\\s+ill(?!-)', 'illness(?:es)?',
    'cancer', 'hospice', 'nursing\\s+home', 'assisted\\s+living', 'dementia',
    'alzheimer\\w*', '(?:health|medical)\\s+(?:issues?|problems?|reasons?|condition)',
  ]
    .map((p) => `\\b${p}\\b`)
    .join('|'),
  'i',
)
// Ordinary phrases that contain those words (removed before the check).
const BENIGN =
  /\breal[\s-]+estates?\b|\bestate[\s-]+(?:agents?|sized)\b|\bjamaica\s+estates\b|\bestates\s+at\b|\b\w+\s+estates\s+(?:condo|co-?op|building|development)s?\b|\bdead[\s-]+end\b|\bdead[\s-]?bolts?\b|\bdeath[\s-]+defying\b|\bdeal\s+died\b|\bdied\s+down\b|\bdying\s+to\b|\bill[\s-]+(?:fated|advised)\b/gi

export function mentionsPersonalCircumstances(text: string | null | undefined): boolean {
  return !!text && PERSONAL.test(text.replace(BENIGN, ' '))
}

// A motivation that mentions any of them is dropped entirely.
export function safeMotivation(motivation: string | null | undefined): string | null {
  const m = motivation?.trim()
  return m && !mentionsPersonalCircumstances(m) ? m : null
}

// Free text without the sentences (or lines) that mention them. Unchanged text
// comes back as it was. Doesn't split after common abbreviations ("Mr. Smith").
const SENTENCE_END = /(?<=(?<!\b(?:Mr|Mrs|Ms|Dr|St|Ave|Jr|Sr|Apt|No))[.!?]["')\]]?)\s+|\n+/
export function withoutPersonalCircumstances(text: string): string {
  if (!mentionsPersonalCircumstances(text)) return text
  const out = text
    .split(SENTENCE_END)
    .filter((sentence) => !mentionsPersonalCircumstances(sentence))
    .join(' ')
    .trim()
  // A phrase split across lines ("passed" / "away") comes back whole when the
  // pieces are joined: fail closed.
  return mentionsPersonalCircumstances(out) ? '' : out
}

// A seller lead's summary as stored: the safe summary plus a safe motivation.
export function sellerSummary(summary: string, motivation: string | null | undefined): string {
  const safe = withoutPersonalCircumstances(summary)
  const m = safeMotivation(motivation)
  return m ? `${safe} Motivation: ${m}`.trim() : safe
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

export function leadFallbackTitle(category: string, place: string | null | undefined): string {
  const kind = category === 'LANDLORD_LEAD' ? 'Landlord lead' : 'Seller lead'
  return place?.trim() ? `${kind} – ${place.trim()}` : kind
}
