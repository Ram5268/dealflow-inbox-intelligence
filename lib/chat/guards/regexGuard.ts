// Brief 5.1, Step 1 — regex-based structural hallucination detector.
//
// Fast, deterministic first pass over Drift's (Sonnet 4.6) final text reply.
// It catches the STRUCTURAL shape of the two hallucination classes the stress
// test surfaced — fabricated URLs, external data-source citations (ACRIS,
// StreetEasy, Zillow…), invented LLC/Corp ownership entities, and dated
// sale-history citations — none of which Drift has a tool to source. Any match
// means the response volunteered a fact not present in tool results.
//
// This runs BEFORE the LLM verifier (cheap gate first). A clean pass here does
// not mean grounded — the semantic verifier still runs; a match here does mean
// the response is rejected and retried regardless of what the verifier thinks.

export interface RegexFlag {
  pattern: string // named pattern that triggered (e.g. 'external_url')
  match: string // the exact matched substring from the response
}

interface NamedPattern {
  name: string
  regex: RegExp
}

// Each pattern is global so we can enumerate every match; names mirror the
// Brief 5.1 spec table. `i` where casing varies in real prose.
const PATTERNS: NamedPattern[] = [
  {
    // Drift has no URL-returning tool. Any URL in a response is fabricated
    // (the live-StreetEasy side-channel is disabled in TEST_MODE).
    name: 'external_url',
    regex: /https?:\/\/[^\s)\]}]+/gi,
  },
  {
    // Named external data sources Drift never queries.
    name: 'real_estate_source_citation',
    regex: /\b(ACRIS|PropertyShark|PLUTO|DOB|StreetEasy|Zillow|Trulia|Realtor\.com|MLS|RLS|REBNY|Redfin|CoreLogic|RealtyTrac|Naked Apartments|OneKey)\b/gi,
  },
  {
    // LLC / Inc / Corp entity names => ownership invention.
    name: 'corporate_entity',
    regex: /\b[A-Z][A-Za-z0-9\s&'-]{2,60}?\s+(LLC|L\.L\.C\.|Inc\.?|Corp\.?|Corporation|LP|L\.P\.|Trust|Holdings|Realty(?:\s+Group)?|Partners)\b/g,
  },
  {
    // "$X on YYYY-MM-DD" => fabricated sale-history citation.
    name: 'dated_dollar_amount',
    regex: /\$[\d,]+(?:\.\d+)?(?:\s*(?:M\b|K\b|million\b|thousand\b))?\s+(?:on|as of|in|from|dated)\s+(?:\d{4}|\w+\s+\d{4}|\d{4}-\d{2}-\d{2})/gi,
  },
  {
    // Ownership claims Drift has no source for.
    name: 'ownership_assertion',
    regex: /\b(owned by|owner is|purchased by|sold to|acquired by|transferred (?:from|to)|previous owner)\b/gi,
  },
  {
    // Historical transaction claims.
    name: 'historical_sale_verb',
    regex: /\b(last sold|previous sale|sold in \d{4}|purchased in \d{4}|acquired in \d{4}|closed on \d{4})\b/gi,
  },
  {
    // Market statistics Drift has no source for. Two shapes:
    //   1. number-first: "10% higher", "8.5% year-over-year", "12% increase"
    //   2. appreciation-first: "appreciation of 8%", "appreciated 5%"
    // NOTE (Brief 5.1.1, Fix 1): bare direction tokens `up`/`down` were dropped
    // from shape 1. "25% down" / "20% down payment" is mortgage LTV terminology,
    // not a market claim, and was firing false positives on straightforward
    // mortgage-math questions. Genuine market declines carry a timeframe/token
    // we still catch ("down 10% YoY" matches on "10% YoY"; "5% lower" on lower).
    name: 'invented_stat',
    regex: /\b\d+(?:\.\d+)?%\s+(?:yoy|year[- ]over[- ]year|higher|lower|increase|decrease|appreciation)\b|\bappreciat(?:ion|ing|ed)\s+(?:of\s+)?\d+(?:\.\d+)?%/gi,
  },
]

/**
 * Scan a candidate response for structural hallucination signatures.
 * Returns one RegexFlag per matched substring (a pattern can fire multiple
 * times). Empty array = structurally clean.
 */
export function scanForStructuralHallucinations(response: string): RegexFlag[] {
  if (!response) return []
  const flags: RegexFlag[] = []
  for (const { name, regex } of PATTERNS) {
    // Fresh lastIndex per call — regex literals are module-level and stateful
    // with the /g flag, so reset before iterating.
    regex.lastIndex = 0
    for (const m of response.matchAll(regex)) {
      flags.push({ pattern: name, match: m[0].trim() })
    }
  }
  return flags
}
