// Brief 32 — pure bucket-key builder shared by carryingReasonableness (feature)
// and compsCache (pre-compute). Kept prisma-free so the feature stays ts-node
// testable. $500k price bands; a bucket is (neighborhood, band, propertyType).
export function carryingBucketKey(
  neighborhood: string | null,
  price: number | null,
  propertyType: string | null,
): string {
  const band = Math.floor((price ?? 0) / 500000)
  return `${neighborhood ?? ''}|${band}|${propertyType ?? ''}`
}
