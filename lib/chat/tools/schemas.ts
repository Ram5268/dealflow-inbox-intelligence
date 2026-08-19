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

export const SEARCH_PARTIES_TOOL: Anthropic.Messages.Tool = {
  name: 'search_parties',
  description:
    'Search the demand + lead side: other agents\' buyers/renters (co-broke opportunities from the inbox) and the broker\'s Mojo CRM seller/landlord leads. ' +
    'role="buyer" -> buyer ISOs, role="renter" -> renter inquiries, role="seller"/"landlord" -> Mojo CRM leads. Omit role to search all. Mojo results carry name + phone. ' +
    'Use priceRangeOverlaps={min,max} to find parties whose budget overlaps a given price. Seed test data is included by default.',
  input_schema: {
    type: 'object',
    properties: {
      role: {
        type: 'string',
        enum: ['buyer', 'renter', 'seller', 'landlord'],
        description: 'buyer/renter -> inbox demand (ISOs). seller/landlord -> Mojo CRM leads. Omit to search all.',
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
