// Seed realistic test opportunities across all categories.
// Every record is flagged isTestData=true — wipe with: scripts/clear-test-data.ts
import { prisma } from '../lib/prisma'
import { embedText, buildOpportunityText } from '../lib/embeddings'

// ── Shared fake raw email (FK anchor for all test records) ────────────────────
async function getOrCreateTestEmail(): Promise<string> {
  const existing = await prisma.rawEmail.findFirst({ where: { subject: '__TEST_SEED__' } })
  if (existing) return existing.id
  const created = await prisma.rawEmail.create({
    data: {
      subject:          '__TEST_SEED__',
      senderName:       'Test Seed',
      senderEmail:      'seed@test.internal',
      graphMessageId:   '__TEST_SEED__',
      bodyPreview:      'Synthetic test record — not a real email.',
      receivedDateTime: new Date().toISOString(),
      processed:        true,
    },
  })
  return created.id
}

// ── Test opportunity definitions ──────────────────────────────────────────────
function records(rawEmailId: string) {
  const base = {
    rawEmailId,
    isTestData:      true,
    isDuplicate:     false,
    processingStatus:'active',
    confidenceScore: 0.95,
    city:   'New York',
    state:  'NY',
    classificationReason: 'Test seed record',
  }

  return [
    // ── ACTIVE SALE LISTINGS ─────────────────────────────────────────────────
    { ...base, category:'ACTIVE_SALE_LISTING', transactionType:'SALE',
      address:'55 West 26th Street #8A', neighborhood:'NoMad', borough:'Manhattan',
      price:1850000, beds:2, baths:2, squareFeet:1150, propertyType:'condo',
      sourceAgentName:'Joshua Lieberman', sourceAgentEmail:'jlieberman@elliman.com', sourceBrokerage:'Douglas Elliman',
      extractedTitle:'Just Listed: NoMad 2BR/2BA Condo $1.85M',
      extractedSummary:'Bright south-facing 2BR/2BA at 55 W 26th. Modern finishes, in-unit W/D, full-service building. 421-a tax abatement through 2029.' },

    { ...base, category:'ACTIVE_SALE_LISTING', transactionType:'SALE',
      address:'215 West 88th Street #12D', neighborhood:'Upper West Side', borough:'Manhattan',
      price:2200000, beds:3, baths:2, squareFeet:1450, propertyType:'co-op',
      sourceAgentName:'Amanda Torres', sourceAgentEmail:'atorres@compass.com', sourceBrokerage:'Compass',
      extractedTitle:'Just Listed: UWS 3BR Pre-War Co-op $2.2M',
      extractedSummary:'Classic 10-room pre-war at the Brentmore. 3BR/2BA, original details, formal dining room. Steps from Riverside Park.' },

    { ...base, category:'ACTIVE_SALE_LISTING', transactionType:'SALE',
      address:'317 East 18th Street #4A', neighborhood:'Gramercy', borough:'Manhattan',
      price:650000, beds:1, baths:1, squareFeet:650, propertyType:'co-op',
      sourceAgentName:'Joshua Lieberman', sourceAgentEmail:'jlieberman@elliman.com', sourceBrokerage:'Douglas Elliman',
      extractedTitle:'Just Listed: Gramercy 1BR Co-op $650K',
      extractedSummary:'Sun-drenched 1BR in pet-friendly co-op. Renovated kitchen, hardwood floors, live-in super. Low maintenance.' },

    { ...base, category:'ACTIVE_SALE_LISTING', transactionType:'SALE',
      address:'40 Mercer Street #5B', neighborhood:'SoHo', borough:'Manhattan',
      price:4750000, beds:3, baths:3, squareFeet:2200, propertyType:'condo',
      sourceAgentName:'Lisa Park', sourceAgentEmail:'lpark@bhsusa.com', sourceBrokerage:'Brown Harris Stevens',
      extractedTitle:'Just Listed: SoHo Loft-Style 3BR $4.75M',
      extractedSummary:'Full-floor loft conversion at 40 Mercer. 11-ft ceilings, chef kitchen, private terrace. Doorman, gym, storage.' },

    { ...base, category:'ACTIVE_SALE_LISTING', transactionType:'SALE',
      address:'230 Ashland Place #22C', neighborhood:'Fort Greene', borough:'Brooklyn',
      price:895000, beds:2, baths:2, squareFeet:980, propertyType:'condo',
      sourceAgentName:'Marcus Williams', sourceAgentEmail:'mwilliams@corcoran.com', sourceBrokerage:'Corcoran',
      extractedTitle:'Just Listed: Fort Greene 2BR Condo $895K',
      extractedSummary:'Contemporary 2BR/2BA at BAM South. Floor-to-ceiling windows, open kitchen, building has roofdeck and gym.' },

    { ...base, category:'ACTIVE_SALE_LISTING', transactionType:'SALE',
      address:'543 7th Street #3', neighborhood:'Park Slope', borough:'Brooklyn',
      price:1299000, beds:3, baths:2, propertyType:'condo',
      sourceAgentName:'Rachel Kim', sourceAgentEmail:'rkim@sothebys.com', sourceBrokerage:"Sotheby's International Realty",
      extractedTitle:'Just Listed: Park Slope 3BR $1.299M',
      extractedSummary:'Renovated 3BR floor-through in landmarked Park Slope brownstone. Private backyard access, original details throughout.' },

    { ...base, category:'ACTIVE_SALE_LISTING', transactionType:'SALE',
      address:'186 North 6th Street #3A', neighborhood:'Williamsburg', borough:'Brooklyn',
      price:1150000, beds:2, baths:2, squareFeet:1050, propertyType:'condo',
      sourceAgentName:'Daniel Chen', sourceAgentEmail:'dchen@compass.com', sourceBrokerage:'Compass',
      extractedTitle:'Just Listed: Williamsburg 2BR Condo $1.15M',
      extractedSummary:'Modern 2BR/2BA in boutique condo steps from the park. Private outdoor space, bike storage, low monthlies.' },

    { ...base, category:'ACTIVE_SALE_LISTING', transactionType:'SALE',
      address:'100 Remsen Street #8G', neighborhood:'Brooklyn Heights', borough:'Brooklyn',
      price:875000, beds:1, baths:1, propertyType:'co-op',
      sourceAgentName:'Sarah Chen', sourceAgentEmail:'schen@compass.com', sourceBrokerage:'Compass',
      extractedTitle:'Just Listed: Brooklyn Heights 1BR Co-op $875K',
      extractedSummary:'Classic 1BR in landmark Brooklyn Heights co-op. High ceilings, prewar details, full-time doorman. Near Borough Hall.' },

    // ── RENTAL LISTINGS ──────────────────────────────────────────────────────
    { ...base, category:'RENTAL_LISTING', transactionType:'RENTAL',
      address:'210 Kent Avenue #5D', neighborhood:'Williamsburg', borough:'Brooklyn',
      price:3800, beds:2, baths:2, squareFeet:950, propertyType:'apartment',
      sourceAgentName:'Tom Walsh', sourceAgentEmail:'twalsh@elliman.com', sourceBrokerage:'Douglas Elliman',
      availabilityDate:'2026-06-01',
      extractedTitle:'For Rent: Williamsburg 2BR/2BA $3,800/mo',
      extractedSummary:'Stunning waterfront 2BR/2BA with Manhattan skyline views. In-unit W/D, dishwasher, building gym and pool. Available June 1.' },

    { ...base, category:'RENTAL_LISTING', transactionType:'RENTAL',
      address:'455 West 37th Street #12B', neighborhood:"Hell's Kitchen", borough:'Manhattan',
      price:4200, beds:2, baths:1, propertyType:'apartment',
      sourceAgentName:'Nina Patel', sourceAgentEmail:'npatel@corcoran.com', sourceBrokerage:'Corcoran',
      availabilityDate:'2026-05-15',
      extractedTitle:"For Rent: Hell's Kitchen 2BR $4,200/mo",
      extractedSummary:"Renovated 2BR with exposed brick and updated kitchen. Laundry in building, elevator, pet-friendly. Hudson Yards adjacent." },

    { ...base, category:'RENTAL_LISTING', transactionType:'RENTAL',
      address:'78 Richardson Street #2R', neighborhood:'Williamsburg', borough:'Brooklyn',
      price:2950, beds:1, baths:1, propertyType:'apartment',
      sourceAgentName:'Amy Goldstein', sourceAgentEmail:'agoldstein@nesthunters.com', sourceBrokerage:'Nest Seekers',
      availabilityDate:'2026-06-01',
      extractedTitle:'For Rent: Williamsburg 1BR $2,950/mo',
      extractedSummary:'Sunny 1BR in heart of N.Williamsburg. Exposed brick, renovated bath, hardwood floors. Steps from L train.' },

    { ...base, category:'RENTAL_LISTING', transactionType:'RENTAL',
      address:'245 East 87th Street #7F', neighborhood:'Yorkville', borough:'Manhattan',
      price:3400, beds:1, baths:1, squareFeet:700, propertyType:'co-op',
      sourceAgentName:'Peter Russo', sourceAgentEmail:'prusso@elliman.com', sourceBrokerage:'Douglas Elliman',
      availabilityDate:'2026-07-01',
      extractedTitle:'For Rent: Yorkville 1BR $3,400/mo — No Fee',
      extractedSummary:'Large 1BR in full-service UES building. Doorman, gym, roof deck. No broker fee. Available July 1.' },

    { ...base, category:'RENTAL_LISTING', transactionType:'RENTAL',
      address:'300 Ashland Place #18A', neighborhood:'Fort Greene', borough:'Brooklyn',
      price:5500, beds:3, baths:2, squareFeet:1300, propertyType:'apartment',
      sourceAgentName:'James Carter', sourceAgentEmail:'jcarter@corcoran.com', sourceBrokerage:'Corcoran',
      availabilityDate:'2026-06-15',
      extractedTitle:'For Rent: Fort Greene 3BR $5,500/mo',
      extractedSummary:'Spacious 3BR/2BA in new construction near BAM. Washer/dryer in unit, private balcony, concierge. Available mid-June.' },

    // ── BUYER ISOs ───────────────────────────────────────────────────────────
    { ...base, category:'BUYER_ISO', transactionType:'BUYER_NEED',
      neighborhood:'Tribeca / SoHo', borough:'Manhattan',
      minPrice:3000000, maxPrice:6000000, price:4500000, beds:3, propertyType:'condo',
      sourceAgentName:'Lisa Park', sourceAgentEmail:'lpark@bhsusa.com', sourceBrokerage:'Brown Harris Stevens',
      clientSide:'buyer',
      extractedTitle:'Buyer ISO: Tribeca/SoHo 3BR+ Condo $3M-$6M',
      extractedSummary:'Pre-approved buyer looking for 3BR+ condo in Tribeca or SoHo. Budget $3M-$6M, flexible on size. Wants doorman, prefers new dev or gut-reno.' },

    { ...base, category:'BUYER_ISO', transactionType:'BUYER_NEED',
      neighborhood:'Park Slope / Carroll Gardens / Cobble Hill', borough:'Brooklyn',
      maxPrice:2500000, price:2000000, beds:3, propertyType:'townhouse',
      sourceAgentName:'Marcus Williams', sourceAgentEmail:'mwilliams@bhsusa.com', sourceBrokerage:'Brown Harris Stevens',
      clientSide:'buyer',
      extractedTitle:'Buyer ISO: Brooklyn Townhouse up to $2.5M',
      extractedSummary:'Buyer looking for 3-4BR townhouse or brownstone in Park Slope, Carroll Gardens, or Cobble Hill. Budget to $2.5M, needs parking or garage.' },

    { ...base, category:'BUYER_ISO', transactionType:'BUYER_NEED',
      neighborhood:'Upper West Side / Morningside Heights', borough:'Manhattan',
      minPrice:1200000, maxPrice:2000000, price:1600000, beds:2, propertyType:'co-op',
      sourceAgentName:'Amanda Torres', sourceAgentEmail:'atorres@compass.com', sourceBrokerage:'Compass',
      clientSide:'buyer',
      extractedTitle:'Buyer ISO: UWS 2BR Co-op $1.2M-$2M',
      extractedSummary:'Downsizing couple seeks 2BR co-op on Upper West Side. Budget $1.2M-$2M. Need washer/dryer allowed. Pre-war preferred, pets (small dog).' },

    { ...base, category:'BUYER_ISO', transactionType:'BUYER_NEED',
      neighborhood:'Williamsburg / Greenpoint', borough:'Brooklyn',
      maxPrice:1500000, price:1200000, beds:2, propertyType:'condo',
      sourceAgentName:'Daniel Chen', sourceAgentEmail:'dchen@compass.com', sourceBrokerage:'Compass',
      clientSide:'buyer',
      extractedTitle:'Buyer ISO: Williamsburg/Greenpoint 2BR Condo to $1.5M',
      extractedSummary:'First-time buyer pre-approved to $1.5M. Wants 2BR condo in Williamsburg or Greenpoint. Needs outdoor space. Can close in 45 days.' },

    { ...base, category:'BUYER_ISO', transactionType:'BUYER_NEED',
      neighborhood:'Bed-Stuy / Crown Heights / Prospect Heights', borough:'Brooklyn',
      maxPrice:2500000, price:2000000, beds:null, units:4, propertyType:'multifamily',
      sourceAgentName:'Rachel Kim', sourceAgentEmail:'rkim@bhsusa.com', sourceBrokerage:'Brown Harris Stevens',
      clientSide:'buyer',
      extractedTitle:'Buyer ISO: Brooklyn 2-4 Family up to $2.5M',
      extractedSummary:'Investor buyer seeking 2-4 family in Bed-Stuy, Crown Heights, or Prospect Heights. Budget $2.5M, can close in 60 days. Cash buyer.' },

    // ── RENTER INQUIRIES ─────────────────────────────────────────────────────
    { ...base, category:'RENTER_INQUIRY', transactionType:'RENTER_NEED',
      neighborhood:'Williamsburg', borough:'Brooklyn',
      maxPrice:3500, price:3500, beds:1, propertyType:'apartment',
      sourceAgentName:'Tom Walsh', sourceAgentEmail:'twalsh@elliman.com', sourceBrokerage:'Douglas Elliman',
      clientSide:'renter',
      availabilityDate:'2026-06-01',
      extractedTitle:'Renter Inquiry: 1BR Williamsburg/Greenpoint up to $3,500/mo',
      extractedSummary:'Renter looking for 1BR in Williamsburg or Greenpoint. Budget $3,500/mo, move-in June 1. Needs pet-friendly (cat), laundry in building.' },

    { ...base, category:'RENTER_INQUIRY', transactionType:'RENTER_NEED',
      neighborhood:'Chelsea / West Village / Greenwich Village', borough:'Manhattan',
      maxPrice:6000, price:5500, beds:2, propertyType:'apartment',
      sourceAgentName:'Nina Patel', sourceAgentEmail:'npatel@corcoran.com', sourceBrokerage:'Corcoran',
      clientSide:'renter',
      availabilityDate:'2026-07-01',
      extractedTitle:'Renter Inquiry: Chelsea/West Village 2BR up to $6K/mo',
      extractedSummary:'Young professional couple seeking 2BR in Chelsea or West Village. Budget $5K-$6K/mo. Must have elevator, dishwasher. Flexible move-in.' },

    { ...base, category:'RENTER_INQUIRY', transactionType:'RENTER_NEED',
      neighborhood:'Astoria / Long Island City', borough:'Queens',
      maxPrice:2800, price:2600, beds:1, propertyType:'apartment',
      clientSide:'renter',
      availabilityDate:'2026-06-15',
      extractedTitle:'Renter Inquiry: Astoria/LIC 1BR under $2,800/mo',
      extractedSummary:'Relocating professional needs 1BR in Astoria or Long Island City. Budget to $2,800/mo, move-in mid-June. Prefers doorman or new construction.' },

    // ── OFF MARKET SALES ─────────────────────────────────────────────────────
    { ...base, category:'OFF_MARKET_SALE', transactionType:'SALE',
      address:'11 North Moore Street #3W', neighborhood:'Tribeca', borough:'Manhattan',
      price:8500000, beds:4, baths:4, squareFeet:3800, propertyType:'condo',
      sourceAgentName:'Lisa Park', sourceAgentEmail:'lpark@bhsusa.com', sourceBrokerage:'Brown Harris Stevens',
      extractedTitle:'Off Market: Tribeca 4BR Loft $8.5M',
      extractedSummary:'Rare full-floor loft in prime Tribeca. 4BR/4BA, 3,800 sq ft, original wood beams, chef kitchen, private elevator. Not on MLS.' },

    { ...base, category:'OFF_MARKET_SALE', transactionType:'SALE',
      address:'18 West 70th Street #PHB', neighborhood:'Upper West Side', borough:'Manhattan',
      price:5200000, beds:4, baths:3, propertyType:'co-op',
      sourceAgentName:'Amanda Torres', sourceAgentEmail:'atorres@compass.com', sourceBrokerage:'Compass',
      extractedTitle:'Off Market: UWS Penthouse Co-op $5.2M',
      extractedSummary:'Private penthouse opportunity in landmark UWS co-op. 4BR/3BA with wraparound terrace and Central Park views. Seller prefers quiet sale.' },

    { ...base, category:'OFF_MARKET_SALE', transactionType:'SALE',
      address:'427 Waverly Avenue', neighborhood:'Clinton Hill', borough:'Brooklyn',
      price:2750000, beds:4, baths:3, propertyType:'townhouse',
      sourceAgentName:'Sarah Chen', sourceAgentEmail:'schen@corcoran.com', sourceBrokerage:'Corcoran',
      extractedTitle:'Off Market: Clinton Hill Limestone Townhouse $2.75M',
      extractedSummary:'3-story limestone townhouse in the heart of Clinton Hill. 4BR/3BA, parlor floor with 12-ft ceilings, private rear garden. Off market.' },

    // ── COMING SOON SALES ────────────────────────────────────────────────────
    { ...base, category:'COMING_SOON_SALE', transactionType:'SALE',
      address:'142 North 8th Street #5C', neighborhood:'Williamsburg', borough:'Brooklyn',
      price:1350000, beds:2, baths:2, propertyType:'condo',
      sourceAgentName:'Daniel Chen', sourceAgentEmail:'dchen@compass.com', sourceBrokerage:'Compass',
      availabilityDate:'2026-06-10',
      extractedTitle:'Coming Soon: Williamsburg 2BR Condo $1.35M',
      extractedSummary:'Coming to market June 10. 2BR/2BA in boutique Williamsburg condo. Private terrace, parking, in-unit W/D. Showing preview available.' },

    { ...base, category:'COMING_SOON_SALE', transactionType:'SALE',
      address:'310 West 79th Street #7B', neighborhood:'Upper West Side', borough:'Manhattan',
      price:1450000, beds:2, baths:2, propertyType:'co-op',
      sourceAgentName:'Peter Russo', sourceAgentEmail:'prusso@elliman.com', sourceBrokerage:'Douglas Elliman',
      availabilityDate:'2026-06-20',
      extractedTitle:'Coming Soon: UWS 2BR/2BA Co-op $1.45M',
      extractedSummary:'Going live June 20. Renovated 2BR/2BA in full-service UWS co-op. Open Sunday previews available for qualified buyers.' },

    { ...base, category:'COMING_SOON_SALE', transactionType:'SALE',
      address:'88 Arden Street #3D', neighborhood:'Inwood', borough:'Manhattan',
      price:625000, beds:2, baths:1, propertyType:'co-op',
      sourceAgentName:'Carlos Rivera', sourceAgentEmail:'crivera@elliman.com', sourceBrokerage:'Douglas Elliman',
      availabilityDate:'2026-06-01',
      extractedTitle:'Coming Soon: Inwood 2BR Co-op $625K',
      extractedSummary:'Coming soon in Inwood. Large 2BR/1BA in elevator co-op with live-in super. Low maintenance. Great for first-time buyers.' },

    // ── COMING SOON RENTALS ──────────────────────────────────────────────────
    { ...base, category:'COMING_SOON_RENTAL', transactionType:'RENTAL',
      address:'389 Atlantic Avenue #4A', neighborhood:'Boerum Hill', borough:'Brooklyn',
      price:3200, beds:1, baths:1, propertyType:'apartment',
      sourceAgentName:'Amy Goldstein', sourceAgentEmail:'agoldstein@nestseekers.com', sourceBrokerage:'Nest Seekers',
      availabilityDate:'2026-07-01',
      extractedTitle:'Coming Soon: Boerum Hill 1BR $3,200/mo — Available July',
      extractedSummary:'1BR going on market July 1 in prime Boerum Hill. Exposed brick, renovated kitchen, outdoor space. Pets OK.' },

    { ...base, category:'COMING_SOON_RENTAL', transactionType:'RENTAL',
      address:'55 Water Street #12F', neighborhood:'DUMBO', borough:'Brooklyn',
      price:4800, beds:2, baths:2, squareFeet:1100, propertyType:'apartment',
      sourceAgentName:'James Carter', sourceAgentEmail:'jcarter@corcoran.com', sourceBrokerage:'Corcoran',
      availabilityDate:'2026-08-01',
      extractedTitle:'Coming Soon: DUMBO 2BR $4,800/mo — August Availability',
      extractedSummary:'2BR/2BA at One John Street complex available August 1. Manhattan bridge views, gym, concierge. Rare summer availability.' },

    // ── COMING SOON DEVELOPMENTS ─────────────────────────────────────────────
    { ...base, category:'COMING_SOON_DEVELOPMENT', transactionType:'SALE',
      address:'95 Madison Avenue', neighborhood:'NoMad', borough:'Manhattan',
      minPrice:1095800, maxPrice:6250000, units:65, propertyType:'condo',
      sourceBrokerage:'Douglas Elliman Development Marketing',
      extractedTitle:'Coming Soon: 95 Madison Residences — NoMad',
      extractedSummary:'Pre-launch: 65 luxury residences in landmark 1912 building. 1-5BR from $1.095M. FXCollaborative architecture, Paris Forino interiors. Sales gallery opening Fall 2026.' },

    { ...base, category:'COMING_SOON_DEVELOPMENT', transactionType:'SALE',
      address:'520 West 28th Street', neighborhood:'Chelsea', borough:'Manhattan',
      minPrice:2200000, maxPrice:15000000, units:36, propertyType:'condo',
      sourceBrokerage:'Corcoran Sunshine',
      extractedTitle:'Coming Soon: 520W28 — Chelsea New Dev',
      extractedSummary:'Zaha Hadid-designed boutique condominium adjacent to the High Line. 36 residences, 2-4BR from $2.2M. Construction completion Q4 2026. VIP preview list open.' },

    // ── DEVELOPMENT INVENTORY ────────────────────────────────────────────────
    { ...base, category:'DEVELOPMENT_INVENTORY', transactionType:'SALE',
      address:'285 West 110th Street', neighborhood:'Upper West Side', borough:'Manhattan',
      minPrice:1095000, maxPrice:6250000, units:72, beds:3, propertyType:'condo',
      sourceBrokerage:'Douglas Elliman Development Marketing',
      extractedTitle:'Now Selling: Circa Central Park — 3 & 4 Beds from $2.45M',
      extractedSummary:'Circa Central Park at 285 W 110th. Sales gallery now open. 3 & 4BRs from $2,450,000. 421-a tax abatement through 2044. Immediate occupancy available.' },

    { ...base, category:'DEVELOPMENT_INVENTORY', transactionType:'SALE',
      address:'130 William Street', neighborhood:'Financial District', borough:'Manhattan',
      minPrice:895000, maxPrice:4500000, units:244, beds:2, propertyType:'condo',
      sourceBrokerage:'Corcoran Sunshine',
      extractedTitle:'Now Selling: 130 William — FiDi Studios to 3BRs from $895K',
      extractedSummary:'130 William Street. Studios to 3BRs now available. David Adjaye-designed tower. Last remaining units. Closings underway.' },

    // ── PRICE DROPS ──────────────────────────────────────────────────────────
    { ...base, category:'PRICE_DROP', transactionType:'SALE',
      address:'167 Perry Street #4C', neighborhood:'West Village', borough:'Manhattan',
      price:2100000, beds:2, baths:2, propertyType:'condo',
      sourceAgentName:'Lisa Park', sourceAgentEmail:'lpark@bhsusa.com', sourceBrokerage:'Brown Harris Stevens',
      extractedTitle:'Price Drop: West Village 2BR $2.1M (was $2.35M)',
      extractedSummary:'West Village condo reduced from $2,350,000 to $2,100,000. Motivated seller relocating. 2BR/2BA with private garden. Immediate availability.' },

    { ...base, category:'PRICE_DROP', transactionType:'SALE',
      address:'543 7th Street #5', neighborhood:'Park Slope', borough:'Brooklyn',
      price:1100000, beds:3, baths:2, propertyType:'condo',
      sourceAgentName:'Rachel Kim', sourceAgentEmail:'rkim@sothebys.com', sourceBrokerage:"Sotheby's International Realty",
      extractedTitle:'Price Improvement: Park Slope 3BR $1.1M (was $1.299M)',
      extractedSummary:'Seller reduced $199K. 3BR/2BA Park Slope floor-through now $1,100,000. Must close by end of Q2. Strong value play.' },

    { ...base, category:'PRICE_DROP', transactionType:'SALE',
      address:'200 East 94th Street #28H', neighborhood:'Yorkville', borough:'Manhattan',
      price:1650000, beds:3, baths:2, propertyType:'condo',
      sourceAgentName:'Peter Russo', sourceAgentEmail:'prusso@elliman.com', sourceBrokerage:'Douglas Elliman',
      extractedTitle:'Price Drop: Yorkville 3BR $1.65M (was $1.795M)',
      extractedSummary:'Reduced $145K. 3BR/2BA at Carnegie Park condo, high floor with open city views. 24hr doorman, pool, gym.' },

    // ── BACK ON MARKET ───────────────────────────────────────────────────────
    { ...base, category:'BACK_ON_MARKET', transactionType:'SALE',
      address:'100 Remsen Street #4D', neighborhood:'Brooklyn Heights', borough:'Brooklyn',
      price:875000, beds:1, baths:1, propertyType:'co-op',
      sourceAgentName:'Sarah Chen', sourceAgentEmail:'schen@compass.com', sourceBrokerage:'Compass',
      extractedTitle:'Back on Market: Brooklyn Heights 1BR $875K — Deal Fell Through',
      extractedSummary:'Pre-war 1BR in Brooklyn Heights back on market after buyer financing fell through. Seller motivated, asking same price. Open house this weekend.' },

    { ...base, category:'BACK_ON_MARKET', transactionType:'SALE',
      address:'48 West 68th Street #9C', neighborhood:'Upper West Side', borough:'Manhattan',
      price:1975000, beds:3, baths:2, propertyType:'co-op',
      sourceAgentName:'Amanda Torres', sourceAgentEmail:'atorres@compass.com', sourceBrokerage:'Compass',
      extractedTitle:'Back on Market: UWS 3BR Co-op $1.975M',
      extractedSummary:'3BR/2BA back after buyer board rejection. Price unchanged at $1,975,000. Strong financials required. Motivated seller.' },

    // ── OPEN HOUSES ──────────────────────────────────────────────────────────
    { ...base, category:'OPEN_HOUSE', transactionType:'SALE',
      address:'427 Waverly Avenue', neighborhood:'Clinton Hill', borough:'Brooklyn',
      price:2750000, beds:4, baths:3, propertyType:'townhouse',
      sourceAgentName:'Sarah Chen', sourceAgentEmail:'schen@corcoran.com', sourceBrokerage:'Corcoran',
      availabilityDate:'2026-05-25',
      extractedTitle:'Open House: Clinton Hill Townhouse $2.75M — Sun May 25',
      extractedSummary:'Limestone townhouse open house Sunday May 25, 1-3pm. 4BR/3BA, parlor-floor entertaining, private garden. All brokers welcome.' },

    { ...base, category:'OPEN_HOUSE', transactionType:'SALE',
      address:'230 West 78th Street #7E', neighborhood:'Upper West Side', borough:'Manhattan',
      price:1100000, beds:2, baths:1, propertyType:'co-op',
      sourceAgentName:'Peter Russo', sourceAgentEmail:'prusso@elliman.com', sourceBrokerage:'Douglas Elliman',
      availabilityDate:'2026-05-24',
      extractedTitle:'Open House: UWS Classic 6 Co-op $1.1M — Sat May 24',
      extractedSummary:'Classic 6 open house Saturday 12-2pm and Sunday 1-3pm. 2BR/1BA with formal dining, eat-in kitchen, high ceilings.' },

    { ...base, category:'OPEN_HOUSE', transactionType:'SALE',
      address:'186 North 6th Street #2A', neighborhood:'Williamsburg', borough:'Brooklyn',
      price:995000, beds:2, baths:1, propertyType:'condo',
      sourceAgentName:'Daniel Chen', sourceAgentEmail:'dchen@compass.com', sourceBrokerage:'Compass',
      availabilityDate:'2026-05-25',
      extractedTitle:'Broker Tour: Williamsburg 2BR $995K — Sunday May 25',
      extractedSummary:'Broker open house Sunday 11am-1pm. 2BR/1BA in prime N.Williamsburg. South-facing, gut-renovated. Refreshments served.' },

    // ── SELLER LEADS ─────────────────────────────────────────────────────────
    { ...base, category:'SELLER_LEAD', transactionType:'SALE',
      address:'892 Park Place', neighborhood:'Crown Heights', borough:'Brooklyn',
      price:1800000, beds:5, baths:3, units:2, propertyType:'2-family',
      sourceAgentName:'Marcus Williams', sourceAgentEmail:'mwilliams@bhsusa.com', sourceBrokerage:'Brown Harris Stevens',
      clientSide:'seller',
      extractedTitle:'Seller Lead: Crown Heights 2-Family $1.8M',
      extractedSummary:'Owner of 2-family in Crown Heights thinking of selling. Property fully occupied, good income. Wants to list in 60-90 days. Referred by past client.' },

    { ...base, category:'SELLER_LEAD', transactionType:'SALE',
      address:'41 West 72nd Street #14A', neighborhood:'Upper West Side', borough:'Manhattan',
      price:2400000, beds:3, baths:2, propertyType:'co-op',
      sourceAgentName:'Amanda Torres', sourceAgentEmail:'atorres@compass.com', sourceBrokerage:'Compass',
      clientSide:'seller',
      extractedTitle:'Seller Lead: UWS 3BR Co-op $2.4M — Wants Listing Appt',
      extractedSummary:'Homeowner at the Ansonia requesting CMA. Lived there 22 years, now downsizing. Good condition, motivated to list by fall.' },

    { ...base, category:'SELLER_LEAD', transactionType:'SALE',
      address:'334 Berry Street', neighborhood:'Williamsburg', borough:'Brooklyn',
      price:3200000, beds:null, units:4, propertyType:'multi-family',
      clientSide:'seller',
      extractedTitle:'Seller Lead: Williamsburg 4-Family $3.2M',
      extractedSummary:'Off-market seller lead — owner of 4-unit Williamsburg building exploring sale. Long-term hold, wants a quiet transaction. Referral from attorney.' },

    // ── LANDLORD LEADS ───────────────────────────────────────────────────────
    { ...base, category:'LANDLORD_LEAD', transactionType:'RENTAL',
      address:'156 Montague Street #3F', neighborhood:'Brooklyn Heights', borough:'Brooklyn',
      price:2800, beds:1, baths:1, propertyType:'apartment',
      clientSide:'landlord',
      availabilityDate:'2026-07-01',
      extractedTitle:'Landlord Lead: Brooklyn Heights 1BR $2,800/mo',
      extractedSummary:'Landlord in Brooklyn Heights looking for tenant. 1BR available July 1. Long-term tenant just left after 8 years. Gut renovated last year.' },

    { ...base, category:'LANDLORD_LEAD', transactionType:'RENTAL',
      address:'78 Grand Street #2L', neighborhood:'SoHo', borough:'Manhattan',
      price:5500, beds:2, baths:1, squareFeet:1200, propertyType:'loft',
      clientSide:'landlord',
      availabilityDate:'2026-06-01',
      extractedTitle:'Landlord Lead: SoHo Loft $5,500/mo',
      extractedSummary:'SoHo owner looking for tenant for raw loft space. 1,200 sq ft on 2nd floor. Currently used as live/work. No fee to tenant.' },

    // ── SHOWING CONFIRMATIONS ────────────────────────────────────────────────
    { ...base, category:'SHOWING_CONFIRMATION', transactionType:'UNKNOWN',
      address:'55 West 26th Street #8A', neighborhood:'NoMad', borough:'Manhattan',
      sourceAgentName:'Joshua Lieberman', sourceAgentEmail:'jlieberman@elliman.com', sourceBrokerage:'Douglas Elliman',
      availabilityDate:'2026-05-22T14:00:00',
      extractedTitle:'Showing Confirmed — 55 W 26th #8A, Thursday 2pm',
      extractedSummary:'Showing confirmed for Thursday May 22 at 2:00 PM. 55 West 26th Street #8A, NoMad. Contact Joshua Lieberman 30 min prior.' },

    { ...base, category:'SHOWING_CONFIRMATION', transactionType:'UNKNOWN',
      address:'230 Ashland Place #22C', neighborhood:'Fort Greene', borough:'Brooklyn',
      sourceAgentName:'Marcus Williams', sourceAgentEmail:'mwilliams@corcoran.com', sourceBrokerage:'Corcoran',
      availabilityDate:'2026-05-23T11:00:00',
      extractedTitle:'Showing Confirmed — 230 Ashland #22C, Friday 11am',
      extractedSummary:'Confirmed: Friday May 23 at 11:00 AM at 230 Ashland Place #22C Fort Greene. Ask for Marcus at front desk.' },

    // ── MARKET REPORTS ───────────────────────────────────────────────────────
    { ...base, category:'MARKET_REPORT', transactionType:'UNKNOWN',
      neighborhood:'Brooklyn', borough:'Brooklyn',
      sourceAgentName:'Research Team', sourceBrokerage:'Douglas Elliman',
      extractedTitle:'Douglas Elliman Q1 2026 Brooklyn Market Report',
      extractedSummary:'Brooklyn Q1 2026: Median sale price $895K (+4.2% YoY). Days on market down to 38. Inventory tightest in Park Slope and Williamsburg. Rental market softening slightly in outer neighborhoods.' },

    { ...base, category:'MARKET_REPORT', transactionType:'UNKNOWN',
      neighborhood:'Manhattan', borough:'Manhattan',
      sourceBrokerage:'StreetEasy Research',
      extractedTitle:'StreetEasy April 2026 Manhattan Market Update',
      extractedSummary:'Manhattan April 2026: Active listings up 8% vs prior year. Median asking price $1.25M. Co-ops trading at 12% discount to condos. Luxury segment ($5M+) seeing renewed activity from international buyers.' },
  ]
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Creating test raw email anchor...')
  const rawEmailId = await getOrCreateTestEmail()

  const data = records(rawEmailId)
  console.log(`Seeding ${data.length} test opportunities...`)

  // Check if records already exist — if so, just generate missing embeddings
  const existingCount = await prisma.extractedOpportunity.count({ where: { isTestData: true } })
  const skipCreate = existingCount >= data.length
  if (skipCreate) console.log(`  ${existingCount} records already exist — skipping create, generating embeddings only...`)

  let created = 0
  let embedded = 0

  const existingOpps = skipCreate
    ? await prisma.extractedOpportunity.findMany({ where: { isTestData: true }, select: { id: true, category: true, address: true, neighborhood: true, borough: true, price: true, minPrice: true, maxPrice: true, beds: true, baths: true, propertyType: true, extractedTitle: true, extractedSummary: true, sourceBrokerage: true } })
    : []

  const oppsToEmbed = skipCreate ? existingOpps : []

  for (const record of (skipCreate ? [] : data)) {
    const opp = await prisma.extractedOpportunity.create({ data: record as never })
    created++
    oppsToEmbed.push(opp as never)

  }

  const total = oppsToEmbed.length
  for (const opp of oppsToEmbed) {
    try {
      const text = buildOpportunityText({
        category:         opp.category,
        address:          opp.address,
        neighborhood:     opp.neighborhood,
        borough:          opp.borough,
        price:            opp.price,
        minPrice:         opp.minPrice,
        maxPrice:         opp.maxPrice,
        beds:             opp.beds,
        baths:            opp.baths,
        propertyType:     opp.propertyType,
        extractedTitle:   opp.extractedTitle,
        extractedSummary: opp.extractedSummary,
        sourceBrokerage:  opp.sourceBrokerage,
      })
      const vector = await embedText(text)
      const pgVector = `[${vector.join(',')}]`
      await prisma.$executeRaw`
        UPDATE "ExtractedOpportunity"
        SET embedding = ${pgVector}::vector
        WHERE id = ${opp.id}
      `
      embedded++
      process.stdout.write(`\r  ${embedded}/${total} embeddings generated`)
    } catch {
      // Non-fatal
    }
    await new Promise(r => setTimeout(r, 100))
  }

  console.log(`\n\n✅ Done — ${created} created, ${embedded}/${total} embeddings generated.`)
  console.log(`   To delete all test data: npx tsx --no-cache scripts/clear-test-data.ts`)
}

main().catch(console.error).finally(() => prisma.$disconnect())
