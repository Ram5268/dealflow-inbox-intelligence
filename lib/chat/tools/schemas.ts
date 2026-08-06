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
