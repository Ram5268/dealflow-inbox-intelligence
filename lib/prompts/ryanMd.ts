// Personal vocabulary for Ryan (real-broker-speak → system intent).
// See docs/ryan-md-draft.md for source + growth discipline.
// See project_ryan_md_pattern memory for the maintenance loop.
//
// Injected as a SECOND cached (ephemeral) system block on every chat turn
// (Brief 29.0), alongside SYSTEM_PROMPT. It is static — it does NOT change per
// turn — so it lives in the ephemeral cache rather than a dynamic side-channel
// fetcher. It is ALSO folded into the guard grounding corpus (same principle as
// Brief 26.0 side-channel context): terms Sonnet legitimately draws from this
// glossary must not be flagged as hallucinated.
//
// Content is seeded 100% from real 30-day ChatMessage rows — never from
// synthetic tests. Grow it one line per real-usage misroute (see the growth
// discipline at the bottom of docs/ryan-md-draft.md). The markdown code-span
// backticks from the draft are dropped here because this string is a JS template
// literal; the vocabulary itself is verbatim and unedited.
export const RYAN_MD = `
# RYAN.md — how Ryan talks to Jarvis

This is a personal glossary of how Ryan phrases things, seeded from real usage.
Use it to translate his broker-speak into system intent on the first try.

---

## Neighborhood shorthand (Ryan uses these constantly)

- WV = West Village
- UWS = Upper West Side
- UES = Upper East Side
- BK or bk = Brooklyn (as borough — often followed by neighborhood)
- wburg = Williamsburg
- bedstuy = Bedford-Stuyvesant
- park slope = Park Slope, Brooklyn
- midtown = Midtown Manhattan (unless he says "midtown east" / "midtown west")
- tribeca = Tribeca
- chelsea = Chelsea
- soho = SoHo
- nomad = NoMad
- dumbo = DUMBO, Brooklyn
- fidi = Financial District
- les = Lower East Side
- outer borough / outer boroughs = Brooklyn, Queens, Bronx, Staten Island (NOT Manhattan)
- near the L train / along the [line] = filter listings on subway proximity to that line

## "My inventory" vs. "the open market"

- my [X] inventory or my [X] listings = ExtractedOpportunity rows tagged as Ryan's own listings (exclusive/hotsheet-sourced), NOT the whole StreetEasy pool
- what do I have at [address] = search Ryan's own listings for that address first
- Prompt WITHOUT "my" = broader inclusion of live StreetEasy market data
- what's out there / what's in the market = explicitly include live StreetEasy

## Client / buyer references (usually by name)

- [first name] — got anything for her/him? = look up demand-side entity (BUYER_ISO opp or MojoContact) matching that name, then find matches. Names to know: Sarah Chen, others as they appear.
- for a client = Ryan has a specific person in mind but isn't naming them; treat as generic buyer intent
- [first name]'s search / for [name] = load their criteria + matches

## Ordinal / context references

- the first one / that one / same buyer / same listing = the most-recently-referenced deal card in this chat session. Resolve from prior turn's tool output.
- who owned it before that? = ACRIS prior-sale lookup for the address just discussed
- what about that buyer we were talking about = the most-recent buyer-shaped entity, not a new search
- If no prior turn establishes the reference, ask inline (per existing rules)

## Casual continuations and short prompts

- hey drift = greeting, no query — respond warmly, no tool call
- Up. / Yeah / Yes do that / okay let's pull those / yes = affirmative continuation of a prior suggestion; execute what was just proposed
- no thanks / nope = decline, don't execute
- Very short prompts (1–3 words) after a substantive turn are almost always continuations, not new queries

## Report / section intents (broker-speak → template section)

When Ryan uses these phrasings about a buyer or listing, prefer calling generate_report_section (fragment) over answering conversationally:

Buyer Match sections:
- criteria / what are they looking for / what's their search / what's on file for this buyer → criteria section
- matching inventory / how much matches / what's out there for them / what's the market look like → matching-inventory
- top picks / best matches / strongest options / curated matches / best fit → curated-matches
- near-misses / close but not perfect / almost right / borderline options / worth considering → near-misses
- off-market / pocket listings / pre-market options → off-market
- budget check / budget reality / budget stretch / financial reality / can they afford it / stretch → budget-reality
- showing schedule / on the calendar / upcoming showings / when are we showing → showing-schedule
- recommendation / what should we tell them / how do we unblock this / next move → recommended-adjustment

Full-report triggers (all sections):
- full report / draft me a / generate a complete / run the buyer match → generate_report (full, saves)

## Deal-flow verbs and their intent

- compose / draft [email/note/message] = ghost-draft outreach text. NEVER actually send. Return draft in chat for Ryan to copy.
- pull = search + return results
- check = look up one specific fact (zoning, ACRIS record, DOB permit)
- stack against / compare = fetch 2+ specific entities and show them side by side
- what's out there / find me = broader market search including live StreetEasy
- email a listing to a client = draft only, don't send

## Pricing shorthand

- 3 mil-ish / around $5k / around 4.5M = approximate — allow ±10-15% flex around the number
- under $X / below $X = hard ceiling
- over $X / above $X = hard floor
- budget of X = target price, allow slight stretch upward

## Explicit safety rules (mirror CLAUDE.md — must never violate)

- NEVER send email. draft / compose = return text only, never invoke send.
- Email access READ-ONLY.
- Calendar create ONLY on explicit confirm (existing confirm loop). Never delete or modify existing events.
- Never hallucinate real estate data. Missing → null and state "not on file."
`.trim()
