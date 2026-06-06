// Phase 4.6 — NYC public-data propertyType enrichment. Public surface.
export { resolvePropertyType, stripBareUnitSuffix } from './resolvePropertyType'
export type { EnrichmentResult, EnrichableOpportunity } from './resolvePropertyType'
export { geocodeAddress, firstStreetNumber, streetNumbersCompatible } from './geocodeAddress'
export type { GeocodeResult, GeocodeRejectReason } from './geocodeAddress'
export { BLDG_CLASS_TO_PROPERTY_TYPE, classifyBuildingClass, looksLikeCoopOwner } from './bldgClassToType'
export type { PropertyType, ClassMapping } from './bldgClassToType'
