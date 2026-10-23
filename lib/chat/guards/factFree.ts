// Brief 43 PR 15 (Q31; Brief 46 drift-2 "Skip the verifier"): the fact-check
// (llmVerifier.ts, a paid Sonnet call, about half of a simple turn's cost) is
// skipped on a reply with nothing in it to check, on a turn that brought no
// facts: "You're welcome.", "Good morning, Ryan." It still runs on any reply
// with a number, a price, a name, an address or a named source, on any reply
// with a draft, and on any turn where a tool or a side lookup (city records,
// StreetEasy, new matches, CRM seller counts) brought facts. When unsure, it
// runs [engineering precaution]. The regex guard runs on every reply either way.
// Pure.

// Longer replies always get checked.
const MAX_FACT_FREE_CHARS = 280

const NUMBER_SIGNS = /[0-9$€£%#]/
const NUMBER_WORDS = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|mil|grand|half|dozen|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/i
// The verifier's "still flag" topics (llmVerifier.ts): prices and charges,
// ownership and sales, records, sizes, comps.
const FACT_WORDS = /\b(?:prices?|priced|pricing|asking|budgets?|sold|sales?|owns?|owners?|ownership|owned|deeds?|llc|corp|zon(?:e|ed|es|ing)|permits?|violations?|tax(?:es)?|maintenance|charges?|square|sq|sqft|cap rate|noi|comps?|closing costs?|mortgage|rates?)\b/i
const LINK = /https?:|www\.|\.(?:com|net|org|io|nyc)\b|@/i

// Capitalised words a fact-free reply may have anywhere.
const ALLOWED_WORDS = new Set(['I', "I'm", "I'll", "I've", "I'd", 'Ryan', 'Drift', 'DealFlow', 'OK'])

/** True when the reply text carries nothing the fact-check could check. */
export function isFactFreeReply(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (t.length > MAX_FACT_FREE_CHARS) return false
  if (NUMBER_SIGNS.test(t) || NUMBER_WORDS.test(t) || FACT_WORDS.test(t) || LINK.test(t)) return false
  // Names, places, addresses and named sources: a capitalised word that doesn't
  // start a sentence, or a capital inside a word (ACRIS, StreetEasy, Bed-Stuy).
  let sentenceStart = true
  for (const raw of t.split(/\s+/)) {
    const word = raw.replace(/[’‘]/g, "'").replace(/^[("'“[]+|[)"'”\].,!?:;]+$/g, '')
    if (word && !ALLOWED_WORDS.has(word)) {
      if (/[A-Z]/.test(word.slice(1))) return false
      if (/^[A-Z]/.test(word) && !sentenceStart) return false
    }
    sentenceStart = /[.!?:;]["'”’)]*$/.test(raw)
  }
  return true
}

export interface FactCheckInput {
  reply: string        // Drift's reply text
  draft: unknown       // the normalised draft (normalizeDraft), or null
  toolCalls: number    // tool results Drift had this turn
  factLookups: number  // side lookups that brought this message's facts (composeContext)
}

/** False only for a fact-free reply, with no draft, on a turn with no tool or side-lookup facts. */
export function factCheckNeeded(i: FactCheckInput): boolean {
  return i.draft != null || i.toolCalls > 0 || i.factLookups > 0 || !isFactFreeReply(i.reply)
}
