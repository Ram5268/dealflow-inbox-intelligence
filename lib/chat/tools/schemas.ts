// Brief 3.0, Step 1c — Anthropic tool schemas.
//
// JSON Schema mirrors of the Zod input schemas in searchListings.ts /
// searchParties.ts. These are what Haiku reads to decide WHEN and HOW to call
// each tool, so the `description` fields carry the NYC-broker conventions the
// model must apply (numbered streets -> Manhattan, budget language, etc.).
// Keep these in lockstep with the Zod schemas — the Zod .parse() is the runtime
// guard, this is the model-facing contract.
import type Anthropic from '@anthropic-ai/sdk'

export const SEARCH_LISTINGS_TOOL: Anthropic.Messages.Tool = {
  name: 'search_listings',
  description:
    'Search the broker\'s property inventory (sale and rental listings). Filter by borough, neighborhoods, beds, and price. ' +
    'priceMin/priceMax set the budget; each result carries a priceOverlapScore (1.0 = squarely in range, fractional = near-miss, 0 = filtered out). Seed test data is included by default.',
  input_schema: {
    type: 'object',
    properties: {
      borough: {
        type: 'string',
        enum: ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'],
        description: 'NYC borough.',
      },
      neighborhoods: {
        type: 'array',
        items: { type: 'string' },
        description: 'Neighborhood names, e.g. ["Park Slope", "Chelsea"].',
      },
      address: {
        type: 'string',
        description: 'Filter by address substring, case-insensitive. Use for direct-address queries like "is there anything at 88 Greenwich Ave?". Matches any listing whose address contains the given string.',
      },
      beds: { type: 'number', description: 'Exact bedroom count. 0 = studio.' },
      bedsMin: { type: 'number', description: 'Minimum bedrooms (inclusive).' },
      bedsMax: { type: 'number', description: 'Maximum bedrooms (inclusive).' },
      priceMin: { type: 'number', description: 'Minimum price/rent. Monthly rent for rentals, sale price for sales.' },
      priceMax: { type: 'number', description: 'Maximum price/rent.' },
      category: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['COMING_SOON_SALE', 'OFF_MARKET_SALE', 'ACTIVE_SALE_LISTING', 'COMING_SOON_RENTAL', 'RENTAL_LISTING'],
        },
        description: 'Explicit listing categories. Usually leave unset and use `intent` instead.',
      },
      intent: {
        type: 'string',
        enum: ['sale', 'rental'],
        description: 'Convenience: "sale" -> sale categories, "rental" -> rental categories.',
      },
      priceTolerance: {
        type: 'number',
        description: 'Fractional price-overlap tolerance (0–0.30, default 0.05). Raise to ~0.15 for "close fits" / near-miss queries.',
      },
      includeTestData: {
        type: 'boolean',
        description: 'Default true. Set false only if the user explicitly asks for production/real listings only.',
      },
      limit: {
        type: 'number',
        description: 'Max cards to return (default 50, max 200). Use a high limit for broad "show me everything" queries.',
      },
    },
    required: [],
  } as Anthropic.Messages.Tool.InputSchema,
}

// Brief 27.0 — Report Engine tools. generate_report builds + SAVES a full report
// (preview card, Phase 1b); generate_report_section returns ONE section inline in
// chat (cheaper, no save). Only unlocked templates are generatable (buyer-match in
// Phase 1a). For buyer-match, params.buyerId is a BUYER_ISO / RENTER_INQUIRY id —
// resolve it with search_parties first if you only have a name.
export const GENERATE_REPORT_TOOL: Anthropic.Messages.Tool = {
  name: 'generate_report',
  description:
    'Generate a FULL report using a report template. Use when the user asks for a complete report ("draft me a buyer match report for Sarah", "generate a buyer match report"). Returns a saved report id + summary metadata; report content renders to the user via a preview card. For a specific piece of a report inline in chat (e.g. "just the near-misses for Sarah"), use generate_report_section instead. Only unlocked templates work (currently: buyer-match). For buyer-match, params must be { buyerId }, where buyerId is a BUYER_ISO or RENTER_INQUIRY opportunity id — call search_parties first to resolve a name to an id.',
  input_schema: {
    type: 'object',
    properties: {
      templateId: { type: 'string', description: 'Template id, e.g. "buyer-match".' },
      params: {
        type: 'object',
        description: 'Template-specific params, e.g. { buyerId: "abc123" } for buyer-match.',
        properties: { buyerId: { type: 'string', description: 'BUYER_ISO / RENTER_INQUIRY opportunity id (from search_parties).' } },
      },
    },
    required: ['templateId', 'params'],
  } as Anthropic.Messages.Tool.InputSchema,
}

export const GENERATE_REPORT_SECTION_TOOL: Anthropic.Messages.Tool = {
  name: 'generate_report_section',
  description:
    'Generate a SINGLE SECTION of a report template, for inline chat display. Use when the user asks about a specific piece ("what are the near-misses for Sarah", "give me the budget check on this buyer", "curated matches for the Soho buyer"). Cheaper and faster than a full report and NOT saved. Returns structured section content that you should restate in full in your reply so the user sees it. For buyer-match, sectionKey is one of: criteria, matching-inventory, curated-matches, near-misses, off-market, budget-reality, showing-schedule, recommended-adjustment; params is { buyerId }.',
  input_schema: {
    type: 'object',
    properties: {
      templateId: { type: 'string', description: 'Template id, e.g. "buyer-match".' },
      sectionKey: { type: 'string', description: 'Section key, e.g. "near-misses" for buyer-match.' },
      params: {
        type: 'object',
        description: 'Template-specific params, e.g. { buyerId: "abc123" }.',
        properties: { buyerId: { type: 'string', description: 'BUYER_ISO / RENTER_INQUIRY opportunity id (from search_parties).' } },
      },
    },
    required: ['templateId', 'sectionKey', 'params'],
  } as Anthropic.Messages.Tool.InputSchema,
}

// Brief 43 PR 5 (D11 [Ryan, 2026-10-18]): search_parties is buyers and renters
// only. Ryan's CRM sellers are never listed or searched; find_seller gives one
// named seller's contact and count_sellers a count.
export const SEARCH_PARTIES_TOOL: Anthropic.Messages.Tool = {
  name: 'search_parties',
  description:
    'Search the demand side: buyers and renters, from other agents (co-broke requests in the inbox) and the ones stored in Ryan\'s CRM. ' +
    'role="buyer" -> buyers, role="renter" -> renters. Omit role for both. ' +
    'Use priceRangeOverlaps={min,max} to find parties whose budget overlaps a given price. Seed test data is included by default.',
  input_schema: {
    type: 'object',
    properties: {
      role: {
        type: 'string',
        enum: ['buyer', 'renter'],
        description: 'buyer -> buyers, renter -> renters. Omit for both.',
      },
      borough: { type: 'string', description: 'NYC borough.' },
      neighborhoods: { type: 'array', items: { type: 'string' }, description: 'Neighborhood names.' },
      beds: { type: 'number', description: 'Exact bedrooms the party wants. 0 = studio.' },
      bedsMin: { type: 'number', description: 'Minimum bedrooms the party wants.' },
      bedsMax: { type: 'number', description: 'Maximum bedrooms the party wants.' },
      priceRangeOverlaps: {
        type: 'object',
        properties: {
          min: { type: 'number' },
          max: { type: 'number' },
        },
        required: ['min', 'max'],
        description: 'Find parties whose budget overlaps this price range (e.g. a listing\'s price).',
      },
      includeTestData: {
        type: 'boolean',
        description: 'Default true. Set false only if the user explicitly asks for production/real listings only.',
      },
      limit: { type: 'number', description: 'Max cards to return (default 50, max 200).' },
    },
    required: [],
  } as Anthropic.Messages.Tool.InputSchema,
}

// Brief 43 PR 5 (D11 [Ryan, 2026-10-18]; by address D13 [Ryan, 2026-10-19]).
export const FIND_SELLER_TOOL: Anthropic.Messages.Tool = {
  name: 'find_seller',
  description:
    'Look up ONE of Ryan\'s CRM sellers, by the name or the street address Ryan gives, to show him that one contact. ' +
    'Use it only when Ryan names a specific seller or gives an address. Never use it to list, browse or search sellers by area, situation or anything else. ' +
    'Returns { match } (one seller: Ryan sees it as a contact card with an Open in CRM button), { candidates } (up to 3 names; ask Ryan which one) or { none: true } (no seller by that name or address in his CRM). ' +
    'doNotContact true means the homeowner asked not to be contacted.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The seller\'s name as Ryan gave it, e.g. "Pat Example".' },
      address: { type: 'string', description: 'The street address as Ryan gave it, e.g. "88 Example Ave". The house number must match exactly.' },
      neighborhood: { type: 'string', description: 'Only with a name, when Ryan picks one of several candidates with that name: the neighborhood he chose, e.g. "Bushwick".' },
    },
    required: [],
  } as Anthropic.Messages.Tool.InputSchema,
}

export const COUNT_SELLERS_TOOL: Anthropic.Messages.Tool = {
  name: 'count_sellers',
  description:
    'Count Ryan\'s CRM sellers, in one neighborhood or borough or in total. Counts are fine to share; never list the sellers. Returns { count, neighborhood }.',
  input_schema: {
    type: 'object',
    properties: {
      neighborhood: { type: 'string', description: 'A neighborhood or borough, e.g. "Bed-Stuy" or "Brooklyn". Omit for all sellers.' },
    },
    required: [],
  } as Anthropic.Messages.Tool.InputSchema,
}

// Brief 43 PR 6 (N1; D11 [Ryan, 2026-10-18]: buyers-for-a-seller questions are
// allowed for one seller Ryan names; by address D13 [Ryan, 2026-10-19]).
export const GET_SELLER_MATCHES_TOOL: Anthropic.Messages.Tool = {
  name: 'get_seller_matches',
  description:
    'The buyers DealFlow matched to ONE of Ryan\'s CRM sellers, named by Ryan or given by street address. Use it for "which buyers match [a seller or an address]?". ' +
    'Never use it to list, browse or search sellers. ' +
    'Returns { seller, count, tiers, buyers } with the same buyers, order and HOT/WARM labels as that seller\'s CRM card and the Matches page: count is every match the seller has, buyers are the best first (each with what they want, the tier, the score and why it fits; testBuyer marks test data). ' +
    'Ryan sees the buyers as a card with an Open in Matches link for each, so never write a link. ' +
    'Or { candidates } (up to 3 names; ask Ryan which one), or { none: true } (no seller by that name or address in his CRM). ' +
    'seller.doNotContact true means the homeowner asked not to be contacted.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The seller\'s name as Ryan gave it, e.g. "Pat Example".' },
      address: { type: 'string', description: 'The street address as Ryan gave it, e.g. "88 Example Ave". The house number must match exactly.' },
    },
    required: [],
  } as Anthropic.Messages.Tool.InputSchema,
}

// Brief 43 PR 6 (Q26): the NEW MATCHES note holds only the top 20 unseen.
export const COUNT_MATCHES_TOOL: Anthropic.Messages.Tool = {
  name: 'count_matches',
  description:
    'Count all of DealFlow\'s buyer matches, for listings and Ryan\'s sellers together, by tier: HOT (fit 80 or more), WARM (65 to 79), POSSIBLE (under 65) or ALL. ' +
    'Use it for "how many HOT matches do I have?". Returns { tier, count, unseen } (unseen = not yet opened on the Matches page).',
  input_schema: {
    type: 'object',
    properties: {
      tier: { type: 'string', enum: ['HOT', 'WARM', 'POSSIBLE', 'ALL'], description: 'Which tier to count. Default ALL.' },
    },
    required: [],
  } as Anthropic.Messages.Tool.InputSchema,
}

// Brief 43 PR 6 (S-11; D14 [Ryan, 2026-10-19]: a count, plus "they're ranked in
// your CRM Queue"; never a list, D11 [Ryan, 2026-10-18]).
export const COUNT_SELLERS_WITH_BUYERS_TOOL: Anthropic.Messages.Tool = {
  name: 'count_sellers_with_buyers',
  description:
    'Count Ryan\'s CRM sellers that have at least one HOT or WARM buyer waiting (the ones his CRM Queue ranks). Use it for "which of my sellers have buyers waiting?". ' +
    'Returns { count, withHot } only, never names. Answer with the count and say they\'re ranked in his CRM Queue; never list or name the sellers.',
  input_schema: { type: 'object', properties: {}, required: [] } as Anthropic.Messages.Tool.InputSchema,
}
