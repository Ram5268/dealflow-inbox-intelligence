// Brief 3.0, Step 1c — Anthropic tool schemas.
//
// JSON Schema mirrors of the Zod input schemas in searchListings.ts /
// searchParties.ts. These are what Haiku reads to decide WHEN and HOW to call
// each tool, so the `description` fields carry the NYC-broker conventions the
// model must apply (numbered streets -> Manhattan, budget language, etc.).
// Keep these in lockstep with the Zod schemas — the Zod .parse() is the runtime
// guard, this is the model-facing contract.
import type Anthropic from '@anthropic-ai/sdk'

// Brief 43 PR 7 (Q11-Q13, Q40; N6): "under" is a hard ceiling, an area is that
// area, an address is that address, and building facts are on the card.
export const SEARCH_LISTINGS_TOOL: Anthropic.Messages.Tool = {
  name: 'search_listings',
  description:
    'Search the broker\'s property inventory (sale and rental listings). Filter by borough, neighborhoods, address, beds, price, units and property type. ' +
    'priceMin/priceMax set the budget; each result carries a priceOverlapScore (1.0 = squarely in range, fractional = near-miss, 0 = filtered out). ' +
    'Cards carry units, propertyType, squareFeet, availabilityDate (the timeline) and sourceBrokerage; null means not on file, so say so plainly. ' +
    'With unitsMin/unitsMax or propertyTypes, notOnFile counts listings that fit every other filter but have no unit count or building type on file; when it is above 0, say so (e.g. "4 more in Bed-Stuy have no unit count on file") rather than "none". Seed test data is included by default.',
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
        description: 'Neighborhood names, e.g. ["Park Slope", "Chelsea"]. Each means exactly that area and its parts ("Harlem" includes Central Harlem, "Midtown" includes Midtown East): "Williamsburg" never includes East Williamsburg, "Harlem" never East Harlem, "Flatbush" never East Flatbush. Name every area you want.',
      },
      nearby: {
        type: 'boolean',
        description: 'Also include the areas next to the named neighborhoods. Only when Ryan asks for nearby or surrounding areas.',
      },
      address: {
        type: 'string',
        description: 'A street address, for direct-address queries like "is there anything at 88 Example Ave?". Give the full address with its street type. The house number must match exactly (88 never matches 188), and so must the street type when given (Ave never matches St). The exact address comes first.',
      },
      beds: { type: 'number', description: 'Exact bedroom count. 0 = studio.' },
      bedsMin: { type: 'number', description: 'Minimum bedrooms (inclusive).' },
      bedsMax: { type: 'number', description: 'Maximum bedrooms (inclusive).' },
      priceMin: { type: 'number', description: 'Minimum price/rent. Monthly rent for rentals, sale price for sales. "over $X" = priceMin X, a hard floor.' },
      priceMax: { type: 'number', description: 'Maximum price/rent. "under $X" = priceMax X, a hard ceiling: nothing above X comes back.' },
      priceAround: {
        type: 'number',
        description: 'The price Ryan named for "around $X", "$X-ish" or "close to $X". Searches X plus or minus 15% and sorts closest to X first. Use it instead of priceMin/priceMax.',
      },
      unitsMin: { type: 'number', description: 'Minimum number of units. "2-3 family" = unitsMin 2, unitsMax 3, with propertyTypes ["multifamily"]. Listings with no unit count on file are left out.' },
      unitsMax: { type: 'number', description: 'Maximum number of units.' },
      propertyTypes: {
        type: 'array',
        items: { type: 'string', enum: ['multifamily', 'condo', 'coop', 'townhouse', 'single_family', 'mixed_use', 'land', 'commercial'] },
        description: 'Building types to keep: multifamily (2+ family), condo, coop, townhouse (brownstones and row houses), single_family, mixed_use, land, commercial. Listings whose type is not on file are left out.',
      },
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
        description: 'How far past priceMin/priceMax a near-miss may fall, as a fraction (0–0.30). Default 0, so "under $X" stays a hard ceiling. Raise to ~0.15 only for "close fits" / near-miss queries.',
      },
      includeTestData: {
        type: 'boolean',
        description: 'Default true. Set false only if the user explicitly asks for production/real listings only.',
      },
      limit: {
        type: 'number',
        // Brief 43 PR 15 (Q31): default 20 (was 50); each card is paid for again on every later round.
        description: 'Max cards to return (default 20, max 200). Use a high limit for broad "show me everything" queries.',
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
      neighborhoods: { type: 'array', items: { type: 'string' }, description: 'Neighborhood names. Each means exactly that area and its parts ("Harlem" includes Central Harlem): "Williamsburg" never includes East Williamsburg.' },
      nearby: { type: 'boolean', description: 'Also include the areas next to the named neighborhoods. Only when Ryan asks for nearby areas.' },
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
        description: 'Find parties whose budget fits this price or range (e.g. a listing\'s price: min = max = the price). A party is kept when the price falls inside their budget, or up to 5% past it.',
      },
      includeTestData: {
        type: 'boolean',
        description: 'Default true. Set false only if the user explicitly asks for production/real listings only.',
      },
      limit: { type: 'number', description: 'Max cards to return (default 20, max 200).' }, // Brief 43 PR 15: was 50
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
