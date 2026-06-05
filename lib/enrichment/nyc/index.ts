// Phase 4.6 — NYC public-data propertyType enrichment. Public surface.
export { resolvePropertyType } from './resolvePropertyType'
export type { EnrichmentResult, EnrichableOpportunity } from './resolvePropertyType'
export { BLDG_CLASS_TO_PROPERTY_TYPE, classifyBuildingClass, looksLikeCoopOwner } from './bldgClassToType'
export type { PropertyType, ClassMapping } from './bldgClassToType'
