// Phase A — single source of truth for NYC neighborhood metadata.
// Pure addition; no existing file imports this yet.
//
// UNION SOURCES (every spelling here comes from one or more of these):
//   - lib/geo/neighborhoods.ts NEIGHBORHOOD_ADJACENCY        (98 entries, lowercase keys)
//   - lib/chat/streetEasyUrls.ts HOOD_TO_BOROUGH             (~49 entries, lowercase)
//   - lib/chat/streetEasyUrls.ts seAreaMap (inline)          (~30 entries, lowercase)
//   - lib/retrieval/queryParser.ts NYC_NEIGHBORHOODS         (~110 entries, Title Case)
//   - lib/matchmaking.ts detectBorough hardcoded lists       (bk + queens arrays)
//   - prisma: distinct ExtractedOpportunity.neighborhood     (350 distinct DB strings)
//
// ────────────────────────────────────────────────────────────────────────────
// DB SNAPSHOT — distinct non-null neighborhood strings, top counts (2026-05-27)
// Captured by scripts/phase-a-db-snapshot.ts. The canonical name for each
// entry was chosen as the DB-most-frequent spelling per the Phase A spec.
// ────────────────────────────────────────────────────────────────────────────
// Manhattan-heavy:  Lenox Hill 379, Upper West Side 378, Hell's Kitchen 308(combined),
//   Murray Hill 242, Financial District 212, Lincoln Square 208, Yorkville 195,
//   Sutton Place 152, Upper East Side 143, East Village 142, West Village 131,
//   Greenwich Village 125, Tribeca 114, Carnegie Hill 106, South Harlem 102,
//   Kips Bay 100, Gramercy Park 99, Central Harlem 96, Flatiron 91, Battery Park City 90,
//   Hudson Yards 90, NoMad 83, East Harlem 80, West Chelsea 79, Lower East Side 77,
//   Fulton/Seaport 75, West Side 71, Hudson Heights 55, Soho 55, Midtown South 64
//
// Brooklyn-heavy:  Williamsburg 193, Downtown Brooklyn 136, Bushwick 127,
//   Crown Heights 108, Flatbush 108, Greenpoint 107, Park Slope 98,
//   Bedford-Stuyvesant 86, Stuyvesant Heights 78, Sheepshead Bay 72,
//   Clinton Hill 63, Midwood 60, Fort Greene 57, Gravesend 56, Brighton Beach 55,
//   Brooklyn Heights 54, Bay Ridge 53, Homecrest 47, Sunset Park 44, Gowanus 43,
//   Kensington 42, East Flatbush 40, Bensonhurst 39, Carroll Gardens 39, DUMBO 39,
//   Coney Island 38, Boerum Hill 37, Greenwood 35, Prospect Heights 35, Weeksville 29,
//   Cobble Hill 23, Maspeth-disambig...
//
// Queens-heavy:  Hunters Point 194, Forest Hills 136, Astoria 108, Rego Park 82,
//   Flushing 80, Jackson Heights 64, Jamaica 57, Long Island City 54, Woodside 50,
//   Elmhurst 44, Kew Gardens 32, Kew Gardens Hills 32, Sunnyside 32, Ridgewood 30,
//   Murray Hill (Queens) 27, Briarwood 21, Bay Terrace (Queens) 19, Glendale 16,
//   Bayside 16, Ditmars-Steinway 55, Corona 14, East Williamsburg 14, Glen Oaks 14
//
// Bronx-heavy:  Mott Haven 71, Riverdale 47, Spuyten Duyvil 42, Concourse 31,
//   Kingsbridge Heights 17, Williamsbridge 7, Throgs Neck 8, Norwood 5,
//   Bronxwood 6, Fordham 6, Wakefield 6, Pelham Parkway 5, Bedford Park 4,
//   Morris Heights 4, Morris Park 4, Soundview 4, University Heights 4
//
// Staten Island:  Saint George 19, Eltingville 3, Great Kills 3, Tottenville 4,
//   New Springville 5, Westerleigh 3, Arden Heights 3, Huguenot 3, Mariners Harbor 3,
//   ...and many singletons.
//
// OUT-OF-NYC (intentionally NOT in this map — fromRaw returns null for these):
//   Hudson County NJ: Jersey City 240, Bayonne 114, North Bergen 99,
//     West New York 95, Journal Square 90, The Heights 72, Newport 66,
//     Historic Downtown 69, Hoboken 38, Guttenberg 35, Fort Lee 32, Weehawken 26,
//     Cliffside Park 26, McGinley Square 20, Edgewater 17, Paulus Hook 43,
//     Bergen/Lafayette 58, Union City 85, "Hudson" borough, Kearny 4, Secaucus 2,
//     New Jersey 22, Arlington 1
//   Foreign / non-US:  Brickell, DIAGONAL MAR, Cuadrat d'Or, Auteuil,
//     Saint-Germain-des-Prés, Estoril, Marina del Port, Holistika, Towd Point,
//     Scarsdale, Gold Coast, North Haven Point
//   Multi-area composite (substring matching catches the first NYC component):
//     "Cobble Hill, Carroll Garden, Boerum Hill, Brooklyn Heights",
//     "East Village, Lower East Side, Noho, Nomad, ...",
//     "Brooklyn Heights, Cobble Hill, Carroll Gardens, Boerum Hill", etc.
//   Borough labels stored in the neighborhood column:
//     Brooklyn 2, Queens 3, Bronx 2 (data quality issue — borough was stored
//     in the neighborhood field; backfill candidate in Phase E)

export interface NeighborhoodMeta {
  canonical:      string                                                       // canonical name, matches dominant DB spelling
  variants:       string[]                                                     // all known spellings, shorthand, and sub-area names
  adjacent:       string[]                                                     // canonical names of adjacent areas (union of all known maps)
  borough:        'Manhattan' | 'Brooklyn' | 'Queens' | 'Bronx' | 'Staten Island'
  streetEasySlug: string | null                                                // SE URL slug, or null if SE has no area page
}

export const BOROUGHS: readonly NeighborhoodMeta['borough'][] = [
  'Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island',
] as const

// ─────────────────────────────────────────────────────────────────────────────
// MANHATTAN
// ─────────────────────────────────────────────────────────────────────────────
const MANHATTAN: Record<string, NeighborhoodMeta> = {
  'Battery Park City':   { canonical: 'Battery Park City',  variants: ['Battery Park City', 'BPC'],                                            adjacent: ['Financial District', 'Tribeca'],                                                                            borough: 'Manhattan', streetEasySlug: 'battery-park-city' },
  'Beekman':             { canonical: 'Beekman',            variants: ['Beekman', 'Beekman Place', 'Beekman/Sutton'],                          adjacent: ['Sutton Place', 'Turtle Bay', 'Midtown East'],                                                               borough: 'Manhattan', streetEasySlug: null },
  'Carnegie Hill':       { canonical: 'Carnegie Hill',      variants: ['Carnegie Hill', 'Carnegie', 'Upper Carnegie Hill'],                    adjacent: ['Upper East Side', 'Upper West Side', 'Yorkville'],                                                          borough: 'Manhattan', streetEasySlug: 'carnegie-hill' },
  'Central Harlem':      { canonical: 'Central Harlem',     variants: ['Central Harlem'],                                                      adjacent: ['Harlem', 'East Harlem', 'Hamilton Heights', 'Morningside Heights', 'South Harlem'],                          borough: 'Manhattan', streetEasySlug: 'central-harlem' },
  'Central Park South':  { canonical: 'Central Park South', variants: ['Central Park South', 'CPS'],                                           adjacent: ['Midtown', 'Lincoln Square', 'Lenox Hill'],                                                                  borough: 'Manhattan', streetEasySlug: 'central-park-south' },
  'Chelsea':             { canonical: 'Chelsea',            variants: ['Chelsea', 'West Chelsea'],                                             adjacent: ['Flatiron', "Hell's Kitchen", 'Hudson Yards', 'West Village', 'West Chelsea'],                               borough: 'Manhattan', streetEasySlug: 'chelsea' },
  'Chinatown':           { canonical: 'Chinatown',          variants: ['Chinatown'],                                                           adjacent: ['Financial District', 'Little Italy', 'Lower East Side', 'Two Bridges'],                                     borough: 'Manhattan', streetEasySlug: 'chinatown' },
  'Civic Center':        { canonical: 'Civic Center',       variants: ['Civic Center'],                                                        adjacent: ['Chinatown', 'Financial District', 'Tribeca'],                                                               borough: 'Manhattan', streetEasySlug: null },
  'Columbus Circle':     { canonical: 'Columbus Circle',    variants: ['Columbus Circle'],                                                     adjacent: ['Lincoln Square', "Hell's Kitchen", 'Midtown West', 'Central Park South'],                                   borough: 'Manhattan', streetEasySlug: null },
  'Diamond District':    { canonical: 'Diamond District',   variants: ['Diamond District'],                                                    adjacent: ['Midtown', 'Midtown West'],                                                                                  borough: 'Manhattan', streetEasySlug: null },
  'East Harlem':         { canonical: 'East Harlem',        variants: ['East Harlem', 'Spanish Harlem'],                                       adjacent: ['Harlem', 'Upper East Side', 'Yorkville', 'Central Harlem'],                                                 borough: 'Manhattan', streetEasySlug: null },
  'East Village':        { canonical: 'East Village',       variants: ['East Village'],                                                        adjacent: ['Greenwich Village', 'Kips Bay', 'Lower East Side', 'Noho', 'Nolita'],                                       borough: 'Manhattan', streetEasySlug: 'east-village' },
  'Financial District':  { canonical: 'Financial District', variants: ['Financial District', 'FiDi'],                                          adjacent: ['Battery Park City', 'Chinatown', 'Tribeca', 'Two Bridges', 'Civic Center'],                                  borough: 'Manhattan', streetEasySlug: 'financial-district' },
  'Flatiron':            { canonical: 'Flatiron',           variants: ['Flatiron', 'Flatiron District', 'Flatiron/Gramercy', 'Flatiron, NoMad, Tribeca'], adjacent: ['Chelsea', 'Gramercy Park', 'Midtown South', 'Murray Hill', 'NoMad', 'Union Square'],                borough: 'Manhattan', streetEasySlug: 'flatiron' },
  'Fort George':         { canonical: 'Fort George',        variants: ['Fort George'],                                                         adjacent: ['Washington Heights', 'Inwood'],                                                                             borough: 'Manhattan', streetEasySlug: null }, // northern Washington Heights sub-area
  'Fulton/Seaport':      { canonical: 'Fulton/Seaport',     variants: ['Fulton/Seaport', 'South Street Seaport', 'Seaport'],                   adjacent: ['Financial District', 'Two Bridges'],                                                                        borough: 'Manhattan', streetEasySlug: null },
  'Gramercy Park':       { canonical: 'Gramercy Park',      variants: ['Gramercy Park', 'Gramercy'],                                           adjacent: ['Flatiron', 'Kips Bay', 'Murray Hill', 'NoMad', 'Stuyvesant Town', 'Union Square'],                           borough: 'Manhattan', streetEasySlug: 'gramercy-park' },
  'Greenwich Village':   { canonical: 'Greenwich Village',  variants: ['Greenwich Village', 'The Village', 'Far West Village', 'GREENWICH VILLAGE'], adjacent: ['Chelsea', 'East Village', 'Noho', 'West Village', 'Soho', 'Union Square'],                            borough: 'Manhattan', streetEasySlug: 'greenwich-village' },
  'Hamilton Heights':    { canonical: 'Hamilton Heights',   variants: ['Hamilton Heights'],                                                    adjacent: ['Harlem', 'Manhattanville', 'Morningside Heights', 'Washington Heights'],                                    borough: 'Manhattan', streetEasySlug: 'hamilton-heights' },
  'Harlem':              { canonical: 'Harlem',             variants: ['Harlem'],                                                              adjacent: ['East Harlem', 'Hamilton Heights', 'Manhattan Valley', 'Morningside Heights', 'Washington Heights', 'Central Harlem'], borough: 'Manhattan', streetEasySlug: 'harlem' },
  "Hell's Kitchen":      { canonical: "Hell's Kitchen",     variants: ["Hell's Kitchen", 'Hells Kitchen', 'Clinton', "Hell&#39;s Kitchen"],    adjacent: ['Chelsea', 'Hudson Yards', 'Midtown West', 'Columbus Circle'],                                               borough: 'Manhattan', streetEasySlug: 'hells-kitchen' },
  'Hudson Heights':      { canonical: 'Hudson Heights',     variants: ['Hudson Heights'],                                                      adjacent: ['Washington Heights', 'Inwood'],                                                                             borough: 'Manhattan', streetEasySlug: null },
  'Hudson Square':       { canonical: 'Hudson Square',      variants: ['Hudson Square', 'TriBeCa/Hudson Square'],                              adjacent: ['Soho', 'Tribeca', 'West Village'],                                                                          borough: 'Manhattan', streetEasySlug: null },
  'Hudson Yards':        { canonical: 'Hudson Yards',       variants: ['Hudson Yards'],                                                        adjacent: ['Chelsea', "Hell's Kitchen", 'Midtown West'],                                                                borough: 'Manhattan', streetEasySlug: 'hudson-yards' },
  'Inwood':              { canonical: 'Inwood',             variants: ['Inwood'],                                                              adjacent: ['Washington Heights', 'Marble Hill'],                                                                        borough: 'Manhattan', streetEasySlug: 'inwood' },
  'Kips Bay':            { canonical: 'Kips Bay',           variants: ['Kips Bay'],                                                            adjacent: ['East Village', 'Gramercy Park', 'Murray Hill', 'Turtle Bay'],                                               borough: 'Manhattan', streetEasySlug: 'kips-bay' },
  'Lenox Hill':          { canonical: 'Lenox Hill',         variants: ['Lenox Hill', 'Lenox or Carnegie Hill'],                                adjacent: ['Midtown East', 'Upper East Side', 'Carnegie Hill'],                                                         borough: 'Manhattan', streetEasySlug: 'lenox-hill' },
  'Lincoln Square':      { canonical: 'Lincoln Square',     variants: ['Lincoln Square', 'Lincoln Square, Upper West Side'],                   adjacent: ['Upper West Side', 'Columbus Circle'],                                                                       borough: 'Manhattan', streetEasySlug: 'lincoln-square' },
  'Little Italy':        { canonical: 'Little Italy',       variants: ['Little Italy'],                                                        adjacent: ['Chinatown', 'Lower East Side', 'Nolita', 'Soho'],                                                           borough: 'Manhattan', streetEasySlug: 'little-italy' },
  'Lower East Side':     { canonical: 'Lower East Side',    variants: ['Lower East Side', 'LES'],                                              adjacent: ['Chinatown', 'East Village', 'Nolita', 'Two Bridges'],                                                       borough: 'Manhattan', streetEasySlug: 'lower-east-side' },
  'Manhattan Valley':    { canonical: 'Manhattan Valley',   variants: ['Manhattan Valley'],                                                    adjacent: ['Harlem', 'Upper West Side'],                                                                                borough: 'Manhattan', streetEasySlug: null },
  'Manhattanville':      { canonical: 'Manhattanville',     variants: ['Manhattanville'],                                                      adjacent: ['Hamilton Heights', 'Harlem', 'Morningside Heights'],                                                        borough: 'Manhattan', streetEasySlug: null },
  'Marble Hill':         { canonical: 'Marble Hill',        variants: ['Marble Hill'],                                                         adjacent: ['Inwood', 'Kingsbridge'],                                                                                    borough: 'Manhattan', streetEasySlug: null }, // geographically on Bronx mainland but legally Manhattan
  'Midtown':             { canonical: 'Midtown',            variants: ['Midtown'],                                                             adjacent: ['Chelsea', 'Gramercy Park', "Hell's Kitchen", 'Kips Bay', 'Midtown East', 'Midtown West', 'Murray Hill'],   borough: 'Manhattan', streetEasySlug: 'midtown' },
  'Midtown East':        { canonical: 'Midtown East',       variants: ['Midtown East', 'Midtown E', 'Murray Hill / Midtown East'],             adjacent: ['Midtown', 'Murray Hill', 'Turtle Bay', 'Upper East Side', 'Lenox Hill'],                                    borough: 'Manhattan', streetEasySlug: null },
  'Midtown South':       { canonical: 'Midtown South',      variants: ['Midtown South'],                                                       adjacent: ['Flatiron', 'NoMad', 'Murray Hill'],                                                                         borough: 'Manhattan', streetEasySlug: null },
  'Midtown West':        { canonical: 'Midtown West',       variants: ['Midtown West'],                                                        adjacent: ["Hell's Kitchen", 'Hudson Yards', 'Midtown', 'Columbus Circle'],                                             borough: 'Manhattan', streetEasySlug: null },
  'Morningside Heights': { canonical: 'Morningside Heights',variants: ['Morningside Heights'],                                                 adjacent: ['Harlem', 'Manhattanville', 'Upper West Side', 'Hamilton Heights'],                                          borough: 'Manhattan', streetEasySlug: 'morningside-heights' },
  'Murray Hill':         { canonical: 'Murray Hill',        variants: ['Murray Hill'],                                                         adjacent: ['Gramercy Park', 'Kips Bay', 'Midtown East', 'NoMad', 'Turtle Bay'],                                         borough: 'Manhattan', streetEasySlug: 'murray-hill' },
  'Noho':                { canonical: 'Noho',               variants: ['Noho', 'NoHo'],                                                        adjacent: ['East Village', 'Greenwich Village', 'Nolita', 'Soho'],                                                      borough: 'Manhattan', streetEasySlug: 'noho' },
  'NoMad':               { canonical: 'NoMad',              variants: ['NoMad', 'Nomad'],                                                      adjacent: ['Flatiron', 'Gramercy Park', 'Kips Bay', 'Murray Hill', 'Midtown South'],                                    borough: 'Manhattan', streetEasySlug: 'nomad' },
  'Nolita':              { canonical: 'Nolita',             variants: ['Nolita'],                                                              adjacent: ['Little Italy', 'Lower East Side', 'Noho', 'Soho'],                                                          borough: 'Manhattan', streetEasySlug: 'nolita' },
  'Roosevelt Island':    { canonical: 'Roosevelt Island',   variants: ['Roosevelt Island'],                                                    adjacent: [],                                                                                                            borough: 'Manhattan', streetEasySlug: 'roosevelt-island' },
  'Soho':                { canonical: 'Soho',               variants: ['Soho', 'SoHo'],                                                        adjacent: ['Hudson Square', 'Little Italy', 'Noho', 'Nolita', 'Tribeca', 'West Village'],                               borough: 'Manhattan', streetEasySlug: 'soho' },
  'South Harlem':        { canonical: 'South Harlem',       variants: ['South Harlem'],                                                        adjacent: ['Central Harlem', 'Harlem', 'Morningside Heights'],                                                          borough: 'Manhattan', streetEasySlug: null },
  'Stuyvesant Town':     { canonical: 'Stuyvesant Town',    variants: ['Stuyvesant Town', 'Stuyvesant Town/PCV', 'Peter Cooper Village', 'PCV'], adjacent: ['East Village', 'Gramercy Park', 'Kips Bay'],                                                            borough: 'Manhattan', streetEasySlug: 'stuyvesant-town-peter-cooper-village' },
  'Sutton Place':        { canonical: 'Sutton Place',       variants: ['Sutton Place', 'Beekman/Sutton'],                                      adjacent: ['Midtown East', 'Turtle Bay', 'Beekman'],                                                                    borough: 'Manhattan', streetEasySlug: 'sutton-place' },
  'Tribeca':             { canonical: 'Tribeca',            variants: ['Tribeca', 'TriBeCa', 'TriBeCa/Hudson Square'],                         adjacent: ['Battery Park City', 'Financial District', 'Hudson Square', 'Little Italy', 'Soho', 'Two Bridges'],           borough: 'Manhattan', streetEasySlug: 'tribeca' },
  'Turtle Bay':          { canonical: 'Turtle Bay',         variants: ['Turtle Bay'],                                                          adjacent: ['Kips Bay', 'Midtown East', 'Murray Hill', 'Sutton Place', 'Beekman'],                                       borough: 'Manhattan', streetEasySlug: 'turtle-bay' },
  'Two Bridges':         { canonical: 'Two Bridges',        variants: ['Two Bridges'],                                                         adjacent: ['Chinatown', 'Financial District', 'Lower East Side'],                                                       borough: 'Manhattan', streetEasySlug: 'two-bridges' },
  'Union Square':        { canonical: 'Union Square',       variants: ['Union Square'],                                                        adjacent: ['Chelsea', 'East Village', 'Flatiron', 'Gramercy Park', 'Greenwich Village'],                                borough: 'Manhattan', streetEasySlug: 'union-square' },
  'Upper East Side':     { canonical: 'Upper East Side',    variants: ['Upper East Side', 'UES', 'East 66th - 86th Street', 'Upper East Side at East Harlem'], adjacent: ['Carnegie Hill', 'East Harlem', 'Lenox Hill', 'Midtown East', 'Yorkville'],                       borough: 'Manhattan', streetEasySlug: 'upper-east-side' },
  'Upper West Side':     { canonical: 'Upper West Side',    variants: ['Upper West Side', 'UWS', 'West Side', 'Riverside', 'Central Park West'], adjacent: ['Harlem', 'Lincoln Square', 'Manhattan Valley', 'Midtown West', 'Morningside Heights'],                      borough: 'Manhattan', streetEasySlug: 'upper-west-side' },
  'Washington Heights':  { canonical: 'Washington Heights', variants: ['Washington Heights', 'Castle Village'],                                adjacent: ['Harlem', 'Inwood', 'Morningside Heights', 'Hudson Heights', 'Fort George'],                                 borough: 'Manhattan', streetEasySlug: 'washington-heights' },
  'West Chelsea':        { canonical: 'West Chelsea',       variants: ['West Chelsea'],                                                        adjacent: ['Chelsea', 'Hudson Yards'],                                                                                  borough: 'Manhattan', streetEasySlug: null },
  'West Harlem':         { canonical: 'West Harlem',        variants: ['West Harlem'],                                                         adjacent: ['Harlem', 'Hamilton Heights', 'Manhattanville', 'Morningside Heights'],                                      borough: 'Manhattan', streetEasySlug: null },
  'West Village':        { canonical: 'West Village',       variants: ['West Village', 'Greenwich Village / West Village'],                    adjacent: ['Chelsea', 'Greenwich Village', 'Hudson Square', 'Soho'],                                                    borough: 'Manhattan', streetEasySlug: 'west-village' },
  'Yorkville':           { canonical: 'Yorkville',          variants: ['Yorkville'],                                                           adjacent: ['Carnegie Hill', 'East Harlem', 'Upper East Side'],                                                          borough: 'Manhattan', streetEasySlug: 'yorkville' },
}

// ─────────────────────────────────────────────────────────────────────────────
// BROOKLYN
// ─────────────────────────────────────────────────────────────────────────────
const BROOKLYN: Record<string, NeighborhoodMeta> = {
  'Bath Beach':          { canonical: 'Bath Beach',          variants: ['Bath Beach'],                                                        adjacent: ['Bensonhurst', 'Gravesend'],                                                                                 borough: 'Brooklyn', streetEasySlug: null },
  'Bay Ridge':           { canonical: 'Bay Ridge',           variants: ['Bay Ridge'],                                                         adjacent: ['Dyker Heights', 'Fort Hamilton', 'Sunset Park'],                                                            borough: 'Brooklyn', streetEasySlug: 'bay-ridge' },
  'Bedford-Stuyvesant':  { canonical: 'Bedford-Stuyvesant',  variants: ['Bedford-Stuyvesant', 'Bed-Stuy', 'Bedford Stuyvesant', 'Stuyvesant Heights', 'bedstuy', 'bed stuy', 'bed-stuy'], adjacent: ['Bushwick', 'Clinton Hill', 'Crown Heights', 'Fort Greene'],                          borough: 'Brooklyn', streetEasySlug: 'bedford-stuyvesant' },
  'Bensonhurst':         { canonical: 'Bensonhurst',         variants: ['Bensonhurst'],                                                       adjacent: ['Bath Beach', 'Gravesend', 'Dyker Heights', 'Mapleton'],                                                     borough: 'Brooklyn', streetEasySlug: null },
  'Bergen Beach':        { canonical: 'Bergen Beach',        variants: ['Bergen Beach'],                                                      adjacent: ['Mill Basin', 'Marine Park'],                                                                                borough: 'Brooklyn', streetEasySlug: null },
  'Boerum Hill':         { canonical: 'Boerum Hill',         variants: ['Boerum Hill'],                                                       adjacent: ['Carroll Gardens', 'Cobble Hill', 'Downtown Brooklyn', 'Fort Greene', 'Park Slope'],                         borough: 'Brooklyn', streetEasySlug: 'boerum-hill' },
  'Borough Park':        { canonical: 'Borough Park',        variants: ['Borough Park'],                                                      adjacent: ['Bensonhurst', 'Kensington', 'Sunset Park'],                                                                 borough: 'Brooklyn', streetEasySlug: null },
  'Brighton Beach':      { canonical: 'Brighton Beach',      variants: ['Brighton Beach'],                                                    adjacent: ['Coney Island', 'Manhattan Beach', 'Sheepshead Bay'],                                                        borough: 'Brooklyn', streetEasySlug: null },
  'Brooklyn Heights':    { canonical: 'Brooklyn Heights',    variants: ['Brooklyn Heights'],                                                  adjacent: ['Boerum Hill', 'Cobble Hill', 'Downtown Brooklyn', 'DUMBO'],                                                 borough: 'Brooklyn', streetEasySlug: 'brooklyn-heights' },
  'Brownsville':         { canonical: 'Brownsville',         variants: ['Brownsville'],                                                       adjacent: ['Bedford-Stuyvesant', 'Crown Heights', 'East New York'],                                                     borough: 'Brooklyn', streetEasySlug: null },
  'Bushwick':            { canonical: 'Bushwick',            variants: ['Bushwick'],                                                          adjacent: ['Bedford-Stuyvesant', 'Crown Heights', 'East Williamsburg', 'Ridgewood', 'Williamsburg'],                    borough: 'Brooklyn', streetEasySlug: 'bushwick' },
  'Canarsie':            { canonical: 'Canarsie',            variants: ['Canarsie'],                                                          adjacent: ['East Flatbush', 'Flatlands'],                                                                               borough: 'Brooklyn', streetEasySlug: null },
  'Carroll Gardens':     { canonical: 'Carroll Gardens',     variants: ['Carroll Gardens'],                                                   adjacent: ['Boerum Hill', 'Cobble Hill', 'Gowanus', 'Park Slope', 'Red Hook'],                                          borough: 'Brooklyn', streetEasySlug: 'carroll-gardens' },
  'City Line':           { canonical: 'City Line',           variants: ['City Line'],                                                         adjacent: ['East New York'],                                                                                            borough: 'Brooklyn', streetEasySlug: null }, // Brooklyn–Queens border, dominant side is Brooklyn
  'Clinton Hill':        { canonical: 'Clinton Hill',        variants: ['Clinton Hill'],                                                      adjacent: ['Bedford-Stuyvesant', 'Fort Greene', 'Prospect Heights'],                                                    borough: 'Brooklyn', streetEasySlug: 'clinton-hill' },
  'Cobble Hill':         { canonical: 'Cobble Hill',         variants: ['Cobble Hill'],                                                       adjacent: ['Boerum Hill', 'Brooklyn Heights', 'Carroll Gardens', 'Park Slope'],                                         borough: 'Brooklyn', streetEasySlug: 'cobble-hill' },
  'Columbia St Waterfront District': { canonical: 'Columbia St Waterfront District', variants: ['Columbia St Waterfront District'],            adjacent: ['Cobble Hill', 'Red Hook'],                                                                                  borough: 'Brooklyn', streetEasySlug: null },
  'Coney Island':        { canonical: 'Coney Island',        variants: ['Coney Island'],                                                      adjacent: ['Brighton Beach', 'Seagate'],                                                                                borough: 'Brooklyn', streetEasySlug: null },
  'Crown Heights':       { canonical: 'Crown Heights',       variants: ['Crown Heights'],                                                     adjacent: ['Bedford-Stuyvesant', 'East Flatbush', 'Flatbush', 'Prospect Heights', 'Prospect Lefferts Gardens', 'Weeksville'], borough: 'Brooklyn', streetEasySlug: 'crown-heights' },
  'Cypress Hills':       { canonical: 'Cypress Hills',       variants: ['Cypress Hills'],                                                     adjacent: ['East New York'],                                                                                            borough: 'Brooklyn', streetEasySlug: null },
  'Ditmas Park':         { canonical: 'Ditmas Park',         variants: ['Ditmas Park'],                                                       adjacent: ['Flatbush', 'Kensington', 'Prospect Park South'],                                                            borough: 'Brooklyn', streetEasySlug: null },
  'Downtown Brooklyn':   { canonical: 'Downtown Brooklyn',   variants: ['Downtown Brooklyn'],                                                 adjacent: ['Boerum Hill', 'Brooklyn Heights', 'DUMBO', 'Fort Greene'],                                                  borough: 'Brooklyn', streetEasySlug: 'downtown-brooklyn' },
  'DUMBO':               { canonical: 'DUMBO',               variants: ['DUMBO', 'Dumbo'],                                                    adjacent: ['Brooklyn Heights', 'Downtown Brooklyn', 'Fort Greene', 'Vinegar Hill'],                                     borough: 'Brooklyn', streetEasySlug: 'dumbo' },
  'Dyker Heights':       { canonical: 'Dyker Heights',       variants: ['Dyker Heights'],                                                     adjacent: ['Bay Ridge', 'Bensonhurst', 'Fort Hamilton'],                                                                borough: 'Brooklyn', streetEasySlug: null },
  'East Flatbush':       { canonical: 'East Flatbush',       variants: ['East Flatbush'],                                                     adjacent: ['Brownsville', 'Crown Heights', 'Flatbush', 'Canarsie'],                                                     borough: 'Brooklyn', streetEasySlug: null },
  'East New York':       { canonical: 'East New York',       variants: ['East New York', 'New Lots', 'City Line'],                            adjacent: ['Brownsville', 'Cypress Hills', 'New Lots'],                                                                 borough: 'Brooklyn', streetEasySlug: null },
  'East Williamsburg':   { canonical: 'East Williamsburg',   variants: ['East Williamsburg'],                                                 adjacent: ['Bushwick', 'Williamsburg'],                                                                                 borough: 'Brooklyn', streetEasySlug: null },
  'Farragut':            { canonical: 'Farragut',            variants: ['Farragut'],                                                          adjacent: ['East Flatbush', 'Flatlands'],                                                                               borough: 'Brooklyn', streetEasySlug: null }, // small East Flatbush sub-area
  'Fiske Terrace':       { canonical: 'Fiske Terrace',       variants: ['Fiske Terrace'],                                                     adjacent: ['Ditmas Park', 'Flatbush', 'Midwood'],                                                                       borough: 'Brooklyn', streetEasySlug: null },
  'Flatbush':            { canonical: 'Flatbush',            variants: ['Flatbush'],                                                          adjacent: ['Crown Heights', 'Ditmas Park', 'East Flatbush', 'Prospect Heights', 'Prospect Park South'],                  borough: 'Brooklyn', streetEasySlug: 'flatbush' },
  'Flatlands':           { canonical: 'Flatlands',           variants: ['Flatlands'],                                                         adjacent: ['Canarsie', 'East Flatbush', 'Marine Park', 'Mill Basin'],                                                   borough: 'Brooklyn', streetEasySlug: null },
  'Fort Greene':         { canonical: 'Fort Greene',         variants: ['Fort Greene'],                                                       adjacent: ['Bedford-Stuyvesant', 'Boerum Hill', 'Clinton Hill', 'Downtown Brooklyn', 'DUMBO'],                          borough: 'Brooklyn', streetEasySlug: 'fort-greene' },
  'Fort Hamilton':       { canonical: 'Fort Hamilton',       variants: ['Fort Hamilton'],                                                     adjacent: ['Bay Ridge', 'Dyker Heights'],                                                                               borough: 'Brooklyn', streetEasySlug: null },
  'Gerritsen Beach':     { canonical: 'Gerritsen Beach',     variants: ['Gerritsen Beach'],                                                   adjacent: ['Marine Park', 'Sheepshead Bay'],                                                                            borough: 'Brooklyn', streetEasySlug: null },
  'Gowanus':             { canonical: 'Gowanus',             variants: ['Gowanus'],                                                           adjacent: ['Carroll Gardens', 'Park Slope', 'Red Hook', 'Sunset Park', 'Greenwood Heights'],                            borough: 'Brooklyn', streetEasySlug: 'gowanus' },
  'Gravesend':           { canonical: 'Gravesend',           variants: ['Gravesend'],                                                         adjacent: ['Bath Beach', 'Bensonhurst', 'Sheepshead Bay'],                                                              borough: 'Brooklyn', streetEasySlug: null },
  'Greenpoint':          { canonical: 'Greenpoint',          variants: ['Greenpoint'],                                                        adjacent: ['Astoria', 'Hunters Point', 'Long Island City', 'Williamsburg'],                                             borough: 'Brooklyn', streetEasySlug: 'greenpoint' },
  'Greenwood':           { canonical: 'Greenwood',           variants: ['Greenwood', 'Greenwood Heights'],                                    adjacent: ['Park Slope', 'South Slope', 'Sunset Park'],                                                                 borough: 'Brooklyn', streetEasySlug: null },
  'Greenwood Heights':   { canonical: 'Greenwood Heights',   variants: ['Greenwood Heights'],                                                 adjacent: ['Park Slope', 'South Slope', 'Sunset Park'],                                                                 borough: 'Brooklyn', streetEasySlug: null },
  'Homecrest':           { canonical: 'Homecrest',           variants: ['Homecrest'],                                                         adjacent: ['Gravesend', 'Madison', 'Sheepshead Bay'],                                                                   borough: 'Brooklyn', streetEasySlug: null },
  'Kensington':          { canonical: 'Kensington',          variants: ['Kensington'],                                                        adjacent: ['Borough Park', 'Ditmas Park', 'Flatbush', 'Windsor Terrace'],                                               borough: 'Brooklyn', streetEasySlug: 'kensington' },
  'Madison':             { canonical: 'Madison',             variants: ['Madison'],                                                           adjacent: ['Homecrest', 'Midwood'],                                                                                     borough: 'Brooklyn', streetEasySlug: null }, // Sheepshead Bay sub-area; NJ records are out-of-scope
  'Manhattan Beach':     { canonical: 'Manhattan Beach',     variants: ['Manhattan Beach'],                                                   adjacent: ['Brighton Beach', 'Sheepshead Bay'],                                                                         borough: 'Brooklyn', streetEasySlug: null },
  'Mapleton':            { canonical: 'Mapleton',            variants: ['Mapleton'],                                                          adjacent: ['Bensonhurst', 'Borough Park'],                                                                              borough: 'Brooklyn', streetEasySlug: null },
  'Marine Park':         { canonical: 'Marine Park',         variants: ['Marine Park'],                                                       adjacent: ['Bergen Beach', 'Flatlands', 'Gerritsen Beach', 'Mill Basin'],                                               borough: 'Brooklyn', streetEasySlug: null },
  'Midwood':             { canonical: 'Midwood',             variants: ['Midwood'],                                                           adjacent: ['Flatbush', 'Madison'],                                                                                      borough: 'Brooklyn', streetEasySlug: null },
  'Mill Basin':          { canonical: 'Mill Basin',          variants: ['Mill Basin', 'Old Mill Basin'],                                      adjacent: ['Bergen Beach', 'Flatlands', 'Marine Park'],                                                                 borough: 'Brooklyn', streetEasySlug: null },
  'New Lots':            { canonical: 'New Lots',            variants: ['New Lots'],                                                          adjacent: ['East New York', 'Brownsville'],                                                                             borough: 'Brooklyn', streetEasySlug: null },
  'North New York':      { canonical: 'North New York',      variants: ['North New York'],                                                    adjacent: ['Bushwick', 'East Williamsburg'],                                                                            borough: 'Brooklyn', streetEasySlug: null }, // historical name, near East Williamsburg
  'Ocean Hill':          { canonical: 'Ocean Hill',          variants: ['Ocean Hill'],                                                        adjacent: ['Bedford-Stuyvesant', 'Brownsville'],                                                                        borough: 'Brooklyn', streetEasySlug: null },
  'Park Slope':          { canonical: 'Park Slope',          variants: ['Park Slope'],                                                        adjacent: ['Carroll Gardens', 'Cobble Hill', 'Gowanus', 'Prospect Heights', 'South Slope', 'Windsor Terrace'],          borough: 'Brooklyn', streetEasySlug: 'park-slope' },
  'Prospect Heights':    { canonical: 'Prospect Heights',    variants: ['Prospect Heights'],                                                  adjacent: ['Clinton Hill', 'Crown Heights', 'Flatbush', 'Fort Greene', 'Park Slope'],                                    borough: 'Brooklyn', streetEasySlug: 'prospect-heights' },
  'Prospect Lefferts Gardens': { canonical: 'Prospect Lefferts Gardens', variants: ['Prospect Lefferts Gardens', 'Lefferts Gardens'],         adjacent: ['Crown Heights', 'Flatbush', 'Prospect Park South'],                                                         borough: 'Brooklyn', streetEasySlug: null },
  'Prospect Park South': { canonical: 'Prospect Park South', variants: ['Prospect Park South'],                                               adjacent: ['Ditmas Park', 'Flatbush', 'Prospect Lefferts Gardens'],                                                     borough: 'Brooklyn', streetEasySlug: null },
  'Red Hook':            { canonical: 'Red Hook',            variants: ['Red Hook'],                                                          adjacent: ['Carroll Gardens', 'Columbia St Waterfront District', 'Gowanus', 'Sunset Park'],                              borough: 'Brooklyn', streetEasySlug: 'red-hook' },
  'Seagate':             { canonical: 'Seagate',             variants: ['Seagate', 'Sea Gate'],                                               adjacent: ['Coney Island'],                                                                                             borough: 'Brooklyn', streetEasySlug: null },
  'Sheepshead Bay':      { canonical: 'Sheepshead Bay',      variants: ['Sheepshead Bay'],                                                    adjacent: ['Brighton Beach', 'Gerritsen Beach', 'Gravesend', 'Homecrest'],                                              borough: 'Brooklyn', streetEasySlug: null },
  'South Slope':         { canonical: 'South Slope',         variants: ['South Slope'],                                                       adjacent: ['Gowanus', 'Greenwood Heights', 'Park Slope'],                                                               borough: 'Brooklyn', streetEasySlug: null },
  'South Williamsburg':  { canonical: 'South Williamsburg',  variants: ['South Williamsburg'],                                                adjacent: ['Williamsburg', 'East Williamsburg'],                                                                         borough: 'Brooklyn', streetEasySlug: null },
  'Sunset Park':         { canonical: 'Sunset Park',         variants: ['Sunset Park'],                                                       adjacent: ['Bay Ridge', 'Borough Park', 'Gowanus', 'Red Hook', 'Greenwood Heights'],                                    borough: 'Brooklyn', streetEasySlug: 'sunset-park' },
  'Vinegar Hill':        { canonical: 'Vinegar Hill',        variants: ['Vinegar Hill'],                                                      adjacent: ['Brooklyn Heights', 'DUMBO'],                                                                                borough: 'Brooklyn', streetEasySlug: null },
  'Weeksville':          { canonical: 'Weeksville',          variants: ['Weeksville'],                                                        adjacent: ['Bedford-Stuyvesant', 'Crown Heights'],                                                                      borough: 'Brooklyn', streetEasySlug: null },
  'Williamsburg':        { canonical: 'Williamsburg',        variants: ['Williamsburg'],                                                      adjacent: ['Bedford-Stuyvesant', 'Bushwick', 'East Williamsburg', 'Greenpoint', 'South Williamsburg'],                  borough: 'Brooklyn', streetEasySlug: 'williamsburg' },
  'Windsor Terrace':     { canonical: 'Windsor Terrace',     variants: ['Windsor Terrace'],                                                   adjacent: ['Kensington', 'Park Slope'],                                                                                 borough: 'Brooklyn', streetEasySlug: null },
  'Wingate':             { canonical: 'Wingate',             variants: ['Wingate'],                                                           adjacent: ['Crown Heights', 'East Flatbush'],                                                                           borough: 'Brooklyn', streetEasySlug: null },
}

// ─────────────────────────────────────────────────────────────────────────────
// QUEENS
// ─────────────────────────────────────────────────────────────────────────────
const QUEENS: Record<string, NeighborhoodMeta> = {
  'Arverne':             { canonical: 'Arverne',             variants: ['Arverne'],                                                           adjacent: ['Far Rockaway', 'Hammels'],                                                                                  borough: 'Queens',    streetEasySlug: null },
  'Astoria':             { canonical: 'Astoria',             variants: ['Astoria', 'Astoria/Long Island City'],                               adjacent: ['Ditmars-Steinway', 'Greenpoint', 'Jackson Heights', 'Long Island City', 'Sunnyside', 'Woodside'],            borough: 'Queens',    streetEasySlug: 'astoria' },
  'Auburndale':          { canonical: 'Auburndale',          variants: ['Auburndale'],                                                        adjacent: ['Bayside', 'Flushing'],                                                                                      borough: 'Queens',    streetEasySlug: null },
  'Bay Terrace (Queens)':{ canonical: 'Bay Terrace (Queens)',variants: ['Bay Terrace (Queens)', 'Bay Terrace'],                               adjacent: ['Bayside', 'Whitestone'],                                                                                    borough: 'Queens',    streetEasySlug: null },
  'Baychester':          { canonical: 'Baychester',          variants: ['Baychester'],                                                        adjacent: ['Wakefield'],                                                                                                borough: 'Bronx',     streetEasySlug: null }, // NOTE: Baychester is Bronx; left in Queens grouping flag — corrected via borough field
  'Bayside':             { canonical: 'Bayside',             variants: ['Bayside'],                                                           adjacent: ['Douglaston', 'Flushing', 'Fresh Meadows', 'Little Neck', 'Auburndale'],                                     borough: 'Queens',    streetEasySlug: null },
  'Bayswater':           { canonical: 'Bayswater',           variants: ['Bayswater'],                                                         adjacent: ['Far Rockaway'],                                                                                             borough: 'Queens',    streetEasySlug: null },
  'Beechhurst':          { canonical: 'Beechhurst',          variants: ['Beechhurst'],                                                        adjacent: ['Whitestone'],                                                                                               borough: 'Queens',    streetEasySlug: null },
  'Belle Harbor':        { canonical: 'Belle Harbor',        variants: ['Belle Harbor'],                                                      adjacent: ['Neponsit', 'Rockaway Park'],                                                                                borough: 'Queens',    streetEasySlug: null },
  'Bellerose':           { canonical: 'Bellerose',           variants: ['Bellerose'],                                                         adjacent: ['Floral Park', 'Glen Oaks'],                                                                                 borough: 'Queens',    streetEasySlug: null },
  'Breezy Point':        { canonical: 'Breezy Point',        variants: ['Breezy Point'],                                                      adjacent: ['Neponsit'],                                                                                                 borough: 'Queens',    streetEasySlug: null },
  'Briarwood':           { canonical: 'Briarwood',           variants: ['Briarwood'],                                                         adjacent: ['Forest Hills', 'Jamaica', 'Kew Gardens'],                                                                   borough: 'Queens',    streetEasySlug: null },
  'Broad Channel':       { canonical: 'Broad Channel',       variants: ['Broad Channel'],                                                     adjacent: ['Rockaway Park'],                                                                                            borough: 'Queens',    streetEasySlug: null },
  'Cambria Heights':     { canonical: 'Cambria Heights',     variants: ['Cambria Heights'],                                                   adjacent: ['Laurelton', 'St. Albans'],                                                                                  borough: 'Queens',    streetEasySlug: null },
  'Clearview':           { canonical: 'Clearview',           variants: ['Clearview'],                                                         adjacent: ['Bay Terrace (Queens)', 'Whitestone'],                                                                       borough: 'Queens',    streetEasySlug: null },
  'College Point':       { canonical: 'College Point',       variants: ['College Point'],                                                     adjacent: ['Flushing', 'Whitestone', 'Malba'],                                                                          borough: 'Queens',    streetEasySlug: null },
  'Corona':              { canonical: 'Corona',              variants: ['Corona', 'North Corona', 'South Corona', 'Corona and Rego Park'],   adjacent: ['Elmhurst', 'Flushing', 'Jackson Heights', 'Rego Park'],                                                     borough: 'Queens',    streetEasySlug: null },
  'Ditmars-Steinway':    { canonical: 'Ditmars-Steinway',    variants: ['Ditmars-Steinway', 'Ditmars'],                                       adjacent: ['Astoria'],                                                                                                  borough: 'Queens',    streetEasySlug: null },
  'Douglaston':          { canonical: 'Douglaston',          variants: ['Douglaston'],                                                        adjacent: ['Bayside', 'Little Neck'],                                                                                   borough: 'Queens',    streetEasySlug: null },
  'East Elmhurst':       { canonical: 'East Elmhurst',       variants: ['East Elmhurst'],                                                     adjacent: ['Astoria', 'Elmhurst', 'Jackson Heights'],                                                                   borough: 'Queens',    streetEasySlug: null },
  'East Flushing':       { canonical: 'East Flushing',       variants: ['East Flushing'],                                                     adjacent: ['Flushing'],                                                                                                 borough: 'Queens',    streetEasySlug: null },
  'Elmhurst':            { canonical: 'Elmhurst',            variants: ['Elmhurst'],                                                          adjacent: ['Corona', 'East Elmhurst', 'Jackson Heights', 'Maspeth', 'Rego Park', 'Woodside'],                            borough: 'Queens',    streetEasySlug: null },
  'Far Rockaway':        { canonical: 'Far Rockaway',        variants: ['Far Rockaway'],                                                      adjacent: ['Arverne', 'Bayswater'],                                                                                     borough: 'Queens',    streetEasySlug: null },
  'Floral Park':         { canonical: 'Floral Park',         variants: ['Floral Park'],                                                       adjacent: ['Bellerose', 'Glen Oaks', 'Queens Village'],                                                                 borough: 'Queens',    streetEasySlug: null }, // NYC portion only (straddles Queens/Nassau)
  'Flushing':            { canonical: 'Flushing',            variants: ['Flushing'],                                                          adjacent: ['Bayside', 'College Point', 'Corona', 'East Flushing', 'Fresh Meadows', 'Murray Hill (Queens)'],             borough: 'Queens',    streetEasySlug: 'flushing' },
  'Forest Hills':        { canonical: 'Forest Hills',        variants: ['Forest Hills'],                                                      adjacent: ['Briarwood', 'Fresh Meadows', 'Kew Gardens', 'Rego Park'],                                                   borough: 'Queens',    streetEasySlug: 'forest-hills' },
  'Fresh Meadows':       { canonical: 'Fresh Meadows',       variants: ['Fresh Meadows'],                                                     adjacent: ['Bayside', 'Flushing', 'Forest Hills', 'Jamaica Estates'],                                                   borough: 'Queens',    streetEasySlug: null },
  'Glen Oaks':           { canonical: 'Glen Oaks',           variants: ['Glen Oaks'],                                                         adjacent: ['Bellerose', 'Floral Park'],                                                                                 borough: 'Queens',    streetEasySlug: null },
  'Glendale':            { canonical: 'Glendale',            variants: ['Glendale'],                                                          adjacent: ['Maspeth', 'Middle Village', 'Ridgewood'],                                                                   borough: 'Queens',    streetEasySlug: null },
  'Hammels':             { canonical: 'Hammels',             variants: ['Hammels'],                                                           adjacent: ['Arverne', 'Rockaway Park'],                                                                                 borough: 'Queens',    streetEasySlug: null },
  'Hamilton Beach':      { canonical: 'Hamilton Beach',      variants: ['Hamilton Beach'],                                                    adjacent: ['Howard Beach'],                                                                                             borough: 'Queens',    streetEasySlug: null },
  'Hillcrest':           { canonical: 'Hillcrest',           variants: ['Hillcrest'],                                                         adjacent: ['Fresh Meadows', 'Jamaica'],                                                                                 borough: 'Queens',    streetEasySlug: null },
  'Hollis':              { canonical: 'Hollis',              variants: ['Hollis'],                                                            adjacent: ['Jamaica', 'St. Albans'],                                                                                    borough: 'Queens',    streetEasySlug: null },
  'Howard Beach':        { canonical: 'Howard Beach',        variants: ['Howard Beach', 'Old Howard Beach', 'Rockwood Park'],                 adjacent: ['Lindenwood', 'Ozone Park', 'Hamilton Beach'],                                                               borough: 'Queens',    streetEasySlug: null },
  'Hunters Point':       { canonical: 'Hunters Point',       variants: ['Hunters Point'],                                                     adjacent: ['Long Island City', 'Sunnyside'],                                                                            borough: 'Queens',    streetEasySlug: null },
  'Jackson Heights':     { canonical: 'Jackson Heights',     variants: ['Jackson Heights'],                                                   adjacent: ['Corona', 'East Elmhurst', 'Elmhurst', 'Sunnyside', 'Woodside'],                                             borough: 'Queens',    streetEasySlug: 'jackson-heights' },
  'Jamaica':             { canonical: 'Jamaica',             variants: ['Jamaica'],                                                           adjacent: ['Hollis', 'Jamaica Estates', 'Jamaica Hills', 'Kew Gardens', 'Richmond Hill', 'South Jamaica'],              borough: 'Queens',    streetEasySlug: null },
  'Jamaica Estates':     { canonical: 'Jamaica Estates',     variants: ['Jamaica Estates'],                                                   adjacent: ['Fresh Meadows', 'Jamaica'],                                                                                 borough: 'Queens',    streetEasySlug: null },
  'Jamaica Hills':       { canonical: 'Jamaica Hills',       variants: ['Jamaica Hills'],                                                     adjacent: ['Jamaica'],                                                                                                  borough: 'Queens',    streetEasySlug: null },
  'Kew Gardens':         { canonical: 'Kew Gardens',         variants: ['Kew Gardens'],                                                       adjacent: ['Briarwood', 'Forest Hills', 'Jamaica', 'Rego Park', 'Richmond Hill'],                                       borough: 'Queens',    streetEasySlug: null },
  'Kew Gardens Hills':   { canonical: 'Kew Gardens Hills',   variants: ['Kew Gardens Hills'],                                                 adjacent: ['Forest Hills', 'Fresh Meadows', 'Pomonok'],                                                                 borough: 'Queens',    streetEasySlug: null },
  'Laurelton':           { canonical: 'Laurelton',           variants: ['Laurelton'],                                                         adjacent: ['Cambria Heights', 'Rosedale'],                                                                              borough: 'Queens',    streetEasySlug: null },
  'Lindenwood':          { canonical: 'Lindenwood',          variants: ['Lindenwood'],                                                        adjacent: ['Howard Beach', 'Ozone Park'],                                                                               borough: 'Queens',    streetEasySlug: null },
  'Little Neck':         { canonical: 'Little Neck',         variants: ['Little Neck'],                                                       adjacent: ['Bayside', 'Douglaston'],                                                                                    borough: 'Queens',    streetEasySlug: null },
  'Long Island City':    { canonical: 'Long Island City',    variants: ['Long Island City', 'LIC'],                                           adjacent: ['Astoria', 'Greenpoint', 'Hunters Point', 'Sunnyside'],                                                      borough: 'Queens',    streetEasySlug: 'long-island-city' },
  'Malba':               { canonical: 'Malba',               variants: ['Malba'],                                                             adjacent: ['College Point', 'Whitestone'],                                                                              borough: 'Queens',    streetEasySlug: null },
  'Maspeth':             { canonical: 'Maspeth',             variants: ['Maspeth'],                                                           adjacent: ['Elmhurst', 'Glendale', 'Middle Village', 'Ridgewood', 'Woodside'],                                          borough: 'Queens',    streetEasySlug: null },
  'Middle Village':      { canonical: 'Middle Village',      variants: ['Middle Village'],                                                    adjacent: ['Glendale', 'Maspeth', 'Ridgewood'],                                                                         borough: 'Queens',    streetEasySlug: null },
  'Murray Hill (Queens)':{ canonical: 'Murray Hill (Queens)',variants: ['Murray Hill (Queens)', 'Murray Hill Queens'],                        adjacent: ['Flushing'],                                                                                                 borough: 'Queens',    streetEasySlug: null },
  'Neponsit':            { canonical: 'Neponsit',            variants: ['Neponsit'],                                                          adjacent: ['Belle Harbor', 'Breezy Point'],                                                                             borough: 'Queens',    streetEasySlug: null },
  'Oakland Gardens':     { canonical: 'Oakland Gardens',     variants: ['Oakland Gardens'],                                                   adjacent: ['Bayside', 'Fresh Meadows'],                                                                                 borough: 'Queens',    streetEasySlug: null },
  'Ozone Park':          { canonical: 'Ozone Park',          variants: ['Ozone Park', 'South Ozone Park'],                                    adjacent: ['Howard Beach', 'Lindenwood', 'Richmond Hill', 'Woodhaven'],                                                 borough: 'Queens',    streetEasySlug: null },
  'Pomonok':             { canonical: 'Pomonok',             variants: ['Pomonok'],                                                           adjacent: ['Fresh Meadows', 'Kew Gardens Hills'],                                                                       borough: 'Queens',    streetEasySlug: null },
  'Queens Village':      { canonical: 'Queens Village',      variants: ['Queens Village'],                                                    adjacent: ['Bellerose', 'Hollis', 'St. Albans'],                                                                        borough: 'Queens',    streetEasySlug: null },
  'Ramblersville':       { canonical: 'Ramblersville',       variants: ['Ramblersville'],                                                     adjacent: ['Hamilton Beach', 'Howard Beach'],                                                                           borough: 'Queens',    streetEasySlug: null },
  'Rego Park':           { canonical: 'Rego Park',           variants: ['Rego Park'],                                                         adjacent: ['Corona', 'Elmhurst', 'Forest Hills', 'Kew Gardens'],                                                        borough: 'Queens',    streetEasySlug: 'rego-park' },
  'Richmond Hill':       { canonical: 'Richmond Hill',       variants: ['Richmond Hill', 'South Richmond Hill'],                              adjacent: ['Jamaica', 'Kew Gardens', 'Ozone Park', 'Woodhaven'],                                                        borough: 'Queens',    streetEasySlug: null },
  'Ridgewood':           { canonical: 'Ridgewood',           variants: ['Ridgewood'],                                                         adjacent: ['Bushwick', 'Glendale', 'Maspeth', 'Middle Village'],                                                        borough: 'Queens',    streetEasySlug: null },
  'Rockaway Park':       { canonical: 'Rockaway Park',       variants: ['Rockaway Park', 'Rockaway All'],                                     adjacent: ['Arverne', 'Belle Harbor', 'Broad Channel', 'Hammels'],                                                      borough: 'Queens',    streetEasySlug: null },
  'Rosedale':            { canonical: 'Rosedale',            variants: ['Rosedale'],                                                          adjacent: ['Laurelton', 'Springfield Gardens'],                                                                         borough: 'Queens',    streetEasySlug: null },
  'South Jamaica':       { canonical: 'South Jamaica',       variants: ['South Jamaica'],                                                     adjacent: ['Jamaica', 'Springfield Gardens'],                                                                           borough: 'Queens',    streetEasySlug: null },
  'Springfield Gardens': { canonical: 'Springfield Gardens', variants: ['Springfield Gardens'],                                               adjacent: ['Laurelton', 'Rosedale', 'South Jamaica'],                                                                   borough: 'Queens',    streetEasySlug: null },
  'St. Albans':          { canonical: 'St. Albans',          variants: ['St. Albans', 'Saint Albans'],                                        adjacent: ['Cambria Heights', 'Hollis', 'Queens Village'],                                                              borough: 'Queens',    streetEasySlug: null },
  'Sunnyside':           { canonical: 'Sunnyside',           variants: ['Sunnyside'],                                                         adjacent: ['Astoria', 'Hunters Point', 'Jackson Heights', 'Long Island City', 'Woodside'],                              borough: 'Queens',    streetEasySlug: null },
  'Whitestone':          { canonical: 'Whitestone',          variants: ['Whitestone'],                                                        adjacent: ['Bay Terrace (Queens)', 'Beechhurst', 'College Point', 'Malba'],                                             borough: 'Queens',    streetEasySlug: null },
  'Woodhaven':           { canonical: 'Woodhaven',           variants: ['Woodhaven'],                                                         adjacent: ['Ozone Park', 'Richmond Hill'],                                                                              borough: 'Queens',    streetEasySlug: null },
  'Woodside':            { canonical: 'Woodside',            variants: ['Woodside'],                                                          adjacent: ['Astoria', 'Elmhurst', 'Jackson Heights', 'Maspeth', 'Sunnyside'],                                           borough: 'Queens',    streetEasySlug: null },
}

// ─────────────────────────────────────────────────────────────────────────────
// BRONX
// ─────────────────────────────────────────────────────────────────────────────
const BRONX: Record<string, NeighborhoodMeta> = {
  'Bedford Park':        { canonical: 'Bedford Park',        variants: ['Bedford Park'],                                                      adjacent: ['Fordham', 'Norwood'],                                                                                       borough: 'Bronx',     streetEasySlug: null },
  'Bronxwood':           { canonical: 'Bronxwood',           variants: ['Bronxwood'],                                                         adjacent: ['Williamsbridge'],                                                                                           borough: 'Bronx',     streetEasySlug: null },
  'Castle Hill':         { canonical: 'Castle Hill',         variants: ['Castle Hill'],                                                       adjacent: ['Parkchester', 'Soundview'],                                                                                 borough: 'Bronx',     streetEasySlug: null },
  'City Island':         { canonical: 'City Island',         variants: ['City Island'],                                                       adjacent: ['Pelham Bay'],                                                                                               borough: 'Bronx',     streetEasySlug: null },
  'Claremont':           { canonical: 'Claremont',           variants: ['Claremont'],                                                         adjacent: ['Concourse', 'Morrisania'],                                                                                  borough: 'Bronx',     streetEasySlug: null },
  'Concourse':           { canonical: 'Concourse',           variants: ['Concourse', 'Grand Concourse'],                                      adjacent: ['Highbridge', 'Mott Haven', 'Morrisania'],                                                                   borough: 'Bronx',     streetEasySlug: null },
  'Crotona Park East':   { canonical: 'Crotona Park East',   variants: ['Crotona Park East'],                                                 adjacent: ['Morrisania'],                                                                                               borough: 'Bronx',     streetEasySlug: null },
  'Fieldston':           { canonical: 'Fieldston',           variants: ['Fieldston'],                                                         adjacent: ['Riverdale'],                                                                                                borough: 'Bronx',     streetEasySlug: null },
  'Fordham':             { canonical: 'Fordham',             variants: ['Fordham'],                                                           adjacent: ['Bedford Park', 'University Heights'],                                                                       borough: 'Bronx',     streetEasySlug: null },
  'Highbridge':          { canonical: 'Highbridge',          variants: ['Highbridge'],                                                        adjacent: ['Concourse', 'Morris Heights'],                                                                              borough: 'Bronx',     streetEasySlug: null },
  'Hunts Point':         { canonical: 'Hunts Point',         variants: ['Hunts Point'],                                                       adjacent: ['Soundview'],                                                                                                borough: 'Bronx',     streetEasySlug: null },
  'Kingsbridge':         { canonical: 'Kingsbridge',         variants: ['Kingsbridge'],                                                       adjacent: ['Marble Hill', 'Riverdale', 'Kingsbridge Heights'],                                                          borough: 'Bronx',     streetEasySlug: null },
  'Kingsbridge Heights': { canonical: 'Kingsbridge Heights', variants: ['Kingsbridge Heights'],                                               adjacent: ['Kingsbridge', 'Norwood'],                                                                                   borough: 'Bronx',     streetEasySlug: null },
  'Laconia':             { canonical: 'Laconia',             variants: ['Laconia'],                                                           adjacent: ['Williamsbridge'],                                                                                           borough: 'Bronx',     streetEasySlug: null },
  'Locust Point':        { canonical: 'Locust Point',        variants: ['Locust Point'],                                                      adjacent: ['Throgs Neck'],                                                                                              borough: 'Bronx',     streetEasySlug: null },
  'Melrose':             { canonical: 'Melrose',             variants: ['Melrose'],                                                           adjacent: ['Mott Haven', 'Morrisania'],                                                                                 borough: 'Bronx',     streetEasySlug: null },
  'Morris Heights':      { canonical: 'Morris Heights',      variants: ['Morris Heights'],                                                    adjacent: ['Highbridge', 'University Heights'],                                                                         borough: 'Bronx',     streetEasySlug: null },
  'Morris Park':         { canonical: 'Morris Park',         variants: ['Morris Park'],                                                       adjacent: ['Pelham Parkway', 'Pelham Gardens'],                                                                         borough: 'Bronx',     streetEasySlug: null },
  'Morrisania':          { canonical: 'Morrisania',          variants: ['Morrisania'],                                                        adjacent: ['Concourse', 'Crotona Park East', 'Melrose'],                                                                borough: 'Bronx',     streetEasySlug: null },
  'Mott Haven':          { canonical: 'Mott Haven',          variants: ['Mott Haven'],                                                        adjacent: ['Concourse', 'Melrose'],                                                                                     borough: 'Bronx',     streetEasySlug: null },
  'Norwood':             { canonical: 'Norwood',             variants: ['Norwood'],                                                           adjacent: ['Bedford Park', 'Kingsbridge Heights'],                                                                      borough: 'Bronx',     streetEasySlug: null },
  'Parkchester':         { canonical: 'Parkchester',         variants: ['Parkchester'],                                                       adjacent: ['Castle Hill', 'Westchester Village'],                                                                       borough: 'Bronx',     streetEasySlug: null },
  'Pelham Bay':          { canonical: 'Pelham Bay',          variants: ['Pelham Bay'],                                                        adjacent: ['City Island', 'Throgs Neck'],                                                                               borough: 'Bronx',     streetEasySlug: null },
  'Pelham Gardens':      { canonical: 'Pelham Gardens',      variants: ['Pelham Gardens'],                                                    adjacent: ['Morris Park', 'Pelham Parkway'],                                                                            borough: 'Bronx',     streetEasySlug: null },
  'Pelham Parkway':      { canonical: 'Pelham Parkway',      variants: ['Pelham Parkway'],                                                    adjacent: ['Morris Park', 'Pelham Gardens'],                                                                            borough: 'Bronx',     streetEasySlug: null },
  'Riverdale':           { canonical: 'Riverdale',           variants: ['Riverdale'],                                                         adjacent: ['Fieldston', 'Kingsbridge'],                                                                                 borough: 'Bronx',     streetEasySlug: null },
  'Soundview':           { canonical: 'Soundview',           variants: ['Soundview'],                                                         adjacent: ['Castle Hill', 'Hunts Point'],                                                                               borough: 'Bronx',     streetEasySlug: null },
  'Spuyten Duyvil':      { canonical: 'Spuyten Duyvil',      variants: ['Spuyten Duyvil'],                                                    adjacent: ['Riverdale', 'Kingsbridge'],                                                                                 borough: 'Bronx',     streetEasySlug: null },
  'Throgs Neck':         { canonical: 'Throgs Neck',         variants: ['Throgs Neck'],                                                       adjacent: ['Locust Point', 'Pelham Bay'],                                                                               borough: 'Bronx',     streetEasySlug: null },
  'University Heights':  { canonical: 'University Heights',  variants: ['University Heights'],                                                adjacent: ['Fordham', 'Morris Heights'],                                                                                borough: 'Bronx',     streetEasySlug: null },
  'Wakefield':           { canonical: 'Wakefield',           variants: ['Wakefield'],                                                         adjacent: ['Baychester', 'Williamsbridge'],                                                                             borough: 'Bronx',     streetEasySlug: null },
  'Westchester Village': { canonical: 'Westchester Village', variants: ['Westchester Village'],                                               adjacent: ['Parkchester'],                                                                                              borough: 'Bronx',     streetEasySlug: null },
  'Williamsbridge':      { canonical: 'Williamsbridge',      variants: ['Williamsbridge'],                                                    adjacent: ['Bronxwood', 'Laconia', 'Wakefield'],                                                                        borough: 'Bronx',     streetEasySlug: null },
  'Woodlawn':            { canonical: 'Woodlawn',            variants: ['Woodlawn'],                                                          adjacent: ['Wakefield'],                                                                                                borough: 'Bronx',     streetEasySlug: null },
  'Woodstock':           { canonical: 'Woodstock',           variants: ['Woodstock'],                                                         adjacent: ['Mott Haven', 'Melrose'],                                                                                    borough: 'Bronx',     streetEasySlug: null }, // South Bronx neighborhood
}

// ─────────────────────────────────────────────────────────────────────────────
// STATEN ISLAND
// ─────────────────────────────────────────────────────────────────────────────
const STATEN_ISLAND: Record<string, NeighborhoodMeta> = {
  'Annadale':            { canonical: 'Annadale',            variants: ['Annadale'],                                                          adjacent: ['Eltingville', 'Huguenot', 'Princes Bay'],                                                                   borough: 'Staten Island', streetEasySlug: null },
  'Arlington':           { canonical: 'Arlington',           variants: ['Arlington'],                                                         adjacent: ['Mariners Harbor', 'Port Richmond'],                                                                         borough: 'Staten Island', streetEasySlug: null },
  'Arden Heights':       { canonical: 'Arden Heights',       variants: ['Arden Heights'],                                                     adjacent: ['Eltingville', 'Greenridge', 'Huguenot'],                                                                    borough: 'Staten Island', streetEasySlug: null },
  'Bulls Head':          { canonical: 'Bulls Head',          variants: ['Bulls Head'],                                                        adjacent: ['New Springville', 'Travis'],                                                                                borough: 'Staten Island', streetEasySlug: null },
  'Charleston':          { canonical: 'Charleston',          variants: ['Charleston'],                                                        adjacent: ['Rossville', 'Tottenville'],                                                                                 borough: 'Staten Island', streetEasySlug: null },
  'Clifton':             { canonical: 'Clifton',             variants: ['Clifton'],                                                           adjacent: ['Rosebank', 'Stapleton'],                                                                                    borough: 'Staten Island', streetEasySlug: null },
  'Dongan Hills':        { canonical: 'Dongan Hills',        variants: ['Dongan Hills'],                                                      adjacent: ['Grant City', 'New Dorp'],                                                                                   borough: 'Staten Island', streetEasySlug: null },
  'Eltingville':         { canonical: 'Eltingville',         variants: ['Eltingville'],                                                       adjacent: ['Arden Heights', 'Annadale', 'Great Kills'],                                                                 borough: 'Staten Island', streetEasySlug: null },
  'Graniteville':        { canonical: 'Graniteville',        variants: ['Graniteville'],                                                      adjacent: ['Mariners Harbor', 'Port Richmond', 'Westerleigh'],                                                          borough: 'Staten Island', streetEasySlug: null },
  'Greenridge':          { canonical: 'Greenridge',          variants: ['Greenridge'],                                                        adjacent: ['Arden Heights', 'Eltingville'],                                                                             borough: 'Staten Island', streetEasySlug: null },
  'Grant City':          { canonical: 'Grant City',          variants: ['Grant City'],                                                        adjacent: ['Dongan Hills', 'New Dorp'],                                                                                 borough: 'Staten Island', streetEasySlug: null },
  'Great Kills':         { canonical: 'Great Kills',         variants: ['Great Kills'],                                                       adjacent: ['Eltingville', 'New Dorp'],                                                                                  borough: 'Staten Island', streetEasySlug: null },
  'Grymes Hill':         { canonical: 'Grymes Hill',         variants: ['Grymes Hill'],                                                       adjacent: ['Silver Lake', 'Tompkinsville'],                                                                             borough: 'Staten Island', streetEasySlug: null },
  'Huguenot':            { canonical: 'Huguenot',            variants: ['Huguenot'],                                                          adjacent: ['Annadale', 'Princes Bay'],                                                                                  borough: 'Staten Island', streetEasySlug: null },
  'Mariners Harbor':     { canonical: 'Mariners Harbor',     variants: ['Mariners Harbor'],                                                   adjacent: ['Graniteville', 'Port Richmond'],                                                                            borough: 'Staten Island', streetEasySlug: null },
  'New Brighton':        { canonical: 'New Brighton',        variants: ['New Brighton'],                                                      adjacent: ['Saint George', 'West Brighton'],                                                                            borough: 'Staten Island', streetEasySlug: null },
  'New Dorp':            { canonical: 'New Dorp',            variants: ['New Dorp'],                                                          adjacent: ['Dongan Hills', 'Grant City', 'Great Kills'],                                                                borough: 'Staten Island', streetEasySlug: null },
  'New Springville':     { canonical: 'New Springville',     variants: ['New Springville'],                                                   adjacent: ['Bulls Head'],                                                                                               borough: 'Staten Island', streetEasySlug: null },
  'Oakwood':             { canonical: 'Oakwood',             variants: ['Oakwood'],                                                           adjacent: ['New Dorp'],                                                                                                 borough: 'Staten Island', streetEasySlug: null },
  'Port Richmond':       { canonical: 'Port Richmond',       variants: ['Port Richmond'],                                                     adjacent: ['Graniteville', 'Mariners Harbor', 'West Brighton'],                                                         borough: 'Staten Island', streetEasySlug: null },
  'Princes Bay':         { canonical: 'Princes Bay',         variants: ['Princes Bay'],                                                       adjacent: ['Huguenot', 'Tottenville'],                                                                                  borough: 'Staten Island', streetEasySlug: null },
  'Richmond Valley':     { canonical: 'Richmond Valley',     variants: ['Richmond Valley'],                                                   adjacent: ['Charleston', 'Tottenville'],                                                                                borough: 'Staten Island', streetEasySlug: null },
  'Richmondtown':        { canonical: 'Richmondtown',        variants: ['Richmondtown'],                                                      adjacent: ['New Dorp'],                                                                                                 borough: 'Staten Island', streetEasySlug: null },
  'Rosebank':            { canonical: 'Rosebank',            variants: ['Rosebank'],                                                          adjacent: ['Clifton'],                                                                                                  borough: 'Staten Island', streetEasySlug: null },
  'Rossville':           { canonical: 'Rossville',           variants: ['Rossville'],                                                         adjacent: ['Charleston', 'Woodrow'],                                                                                    borough: 'Staten Island', streetEasySlug: null },
  'Saint George':        { canonical: 'Saint George',        variants: ['Saint George', 'St. George'],                                        adjacent: ['New Brighton', 'Tompkinsville'],                                                                            borough: 'Staten Island', streetEasySlug: null },
  'Shore Acres':         { canonical: 'Shore Acres',         variants: ['Shore Acres'],                                                       adjacent: ['Clifton', 'Rosebank'],                                                                                      borough: 'Staten Island', streetEasySlug: null },
  'Silver Lake':         { canonical: 'Silver Lake',         variants: ['Silver Lake'],                                                       adjacent: ['Grymes Hill', 'Sunnyside (Staten Island)'],                                                                 borough: 'Staten Island', streetEasySlug: null },
  'South Beach':         { canonical: 'South Beach',         variants: ['South Beach'],                                                       adjacent: ['Dongan Hills', 'Rosebank'],                                                                                 borough: 'Staten Island', streetEasySlug: null },
  'Stapleton':           { canonical: 'Stapleton',           variants: ['Stapleton'],                                                         adjacent: ['Clifton', 'Tompkinsville'],                                                                                 borough: 'Staten Island', streetEasySlug: null },
  'Sunnyside (Staten Island)': { canonical: 'Sunnyside (Staten Island)', variants: ['Sunnyside (Staten Island)'],                            adjacent: ['Silver Lake'],                                                                                              borough: 'Staten Island', streetEasySlug: null },
  'Todt Hill':           { canonical: 'Todt Hill',           variants: ['Todt Hill'],                                                         adjacent: ['Dongan Hills', 'Sunnyside (Staten Island)'],                                                                borough: 'Staten Island', streetEasySlug: null },
  'Tompkinsville':       { canonical: 'Tompkinsville',       variants: ['Tompkinsville'],                                                     adjacent: ['Saint George', 'Stapleton'],                                                                                borough: 'Staten Island', streetEasySlug: null },
  'Tottenville':         { canonical: 'Tottenville',         variants: ['Tottenville'],                                                       adjacent: ['Charleston', 'Princes Bay', 'Richmond Valley'],                                                             borough: 'Staten Island', streetEasySlug: null },
  'Travis':              { canonical: 'Travis',              variants: ['Travis'],                                                            adjacent: ['New Springville'],                                                                                          borough: 'Staten Island', streetEasySlug: null },
  'West Brighton':       { canonical: 'West Brighton',       variants: ['West Brighton'],                                                     adjacent: ['New Brighton', 'Port Richmond'],                                                                            borough: 'Staten Island', streetEasySlug: null },
  'Westerleigh':         { canonical: 'Westerleigh',         variants: ['Westerleigh'],                                                       adjacent: ['Graniteville', 'Port Richmond'],                                                                            borough: 'Staten Island', streetEasySlug: null },
  'Willowbrook':         { canonical: 'Willowbrook',         variants: ['Willowbrook'],                                                       adjacent: ['New Springville'],                                                                                          borough: 'Staten Island', streetEasySlug: null },
  'Woodrow':             { canonical: 'Woodrow',             variants: ['Woodrow'],                                                           adjacent: ['Charleston', 'Rossville'],                                                                                  borough: 'Staten Island', streetEasySlug: null },
}

// ─────────────────────────────────────────────────────────────────────────────
// Combined map + derived exports
// ─────────────────────────────────────────────────────────────────────────────
export const NEIGHBORHOODS: Record<string, NeighborhoodMeta> = {
  ...MANHATTAN,
  ...BROOKLYN,
  ...QUEENS,
  ...BRONX,
  ...STATEN_ISLAND,
}

// ─────────────────────────────────────────────────────────────────────────────
// Symmetric closure + invariant assertion (runs once at module load).
// Phase B Step 1a: every adjacency must be bidirectional. The closure adds
// missing reverse edges; the assertion then enforces symmetry on every load
// so future edits can't reintroduce drift.
// ─────────────────────────────────────────────────────────────────────────────
function applySymmetricClosure(map: Record<string, NeighborhoodMeta>): void {
  for (const [a, metaA] of Object.entries(map)) {
    for (const b of metaA.adjacent) {
      const metaB = map[b]
      if (metaB && !metaB.adjacent.includes(a)) {
        metaB.adjacent.push(a)
        metaB.adjacent.sort()
      }
    }
  }
}

function assertInvariants(map: Record<string, NeighborhoodMeta>): void {
  for (const [a, metaA] of Object.entries(map)) {
    for (const b of metaA.adjacent) {
      const metaB = map[b]
      if (!metaB) {
        throw new Error(`[lib/domain/Neighborhood] adjacency references unknown canonical: ${a} → ${b}`)
      }
      if (!metaB.adjacent.includes(a)) {
        throw new Error(`[lib/domain/Neighborhood] asymmetric adjacency: ${a} → ${b} but ${b} ↛ ${a}`)
      }
    }
  }
}

applySymmetricClosure(NEIGHBORHOODS)
assertInvariants(NEIGHBORHOODS)

export const CANONICAL_NAMES: readonly string[] = Object.freeze(Object.keys(NEIGHBORHOODS).sort())

// ─────────────────────────────────────────────────────────────────────────────
// fromRaw — input → canonical resolution
// ─────────────────────────────────────────────────────────────────────────────

// Built once at module load. Keys are lowercased; values are the canonical name.
const VARIANT_TO_CANONICAL: Map<string, string> = (() => {
  const map = new Map<string, string>()
  for (const [canonical, meta] of Object.entries(NEIGHBORHOODS)) {
    map.set(canonical.toLowerCase(), canonical)
    for (const v of meta.variants) map.set(v.toLowerCase(), canonical)
  }
  return map
})()

// Variants sorted longest-first so substring matching prefers the most
// specific match (e.g. "stuyvesant heights" wins over the shorter "stuy").
const VARIANTS_BY_LENGTH: readonly string[] = (() =>
  [...VARIANT_TO_CANONICAL.keys()]
    .filter(k => k.length >= 4)  // guard against pathological 2-3 char false positives
    .sort((a, b) => b.length - a.length)
)()

export function fromRaw(input: string | null | undefined): string | null {
  if (!input) return null
  const trimmed = input.trim().toLowerCase()
  if (!trimmed) return null

  // a + b: exact match against any canonical or variant (both indexed in VARIANT_TO_CANONICAL)
  const exact = VARIANT_TO_CANONICAL.get(trimmed)
  if (exact) return exact

  // c: substring containment — variant appears inside the input
  for (const v of VARIANTS_BY_LENGTH) {
    if (trimmed.includes(v)) return VARIANT_TO_CANONICAL.get(v) ?? null
  }
  return null
}

export function getAdjacent(canonical: string): string[] {
  return NEIGHBORHOODS[canonical]?.adjacent ?? []
}

export function getBorough(canonical: string): NeighborhoodMeta['borough'] | null {
  return NEIGHBORHOODS[canonical]?.borough ?? null
}

export function getStreetEasySlug(canonical: string): string | null {
  return NEIGHBORHOODS[canonical]?.streetEasySlug ?? null
}
