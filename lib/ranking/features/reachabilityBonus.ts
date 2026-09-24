import type { AggregatedContact, RankingFeatureResult } from '../types'

// Easier-to-reach contacts (more non-DNC mobile lines) rank a little higher.
// Missing DNC/type entries are treated as false/'' (best-effort inclusion).
export function computeReachabilityBonus(c: AggregatedContact): RankingFeatureResult {
  const allPhones = [c.contact.phone, ...c.contact.additionalPhones]
  let nonDncMobile = 0
  let nonDncLandline = 0
  allPhones.forEach((phone, i) => {
    if (phone == null) return
    const dnc = c.contact.phoneDncFlags[i] ?? false
    if (dnc) return
    const type = c.contact.phoneTypes[i] ?? ''
    if (type === 'mobile') nonDncMobile++
    else if (type === 'landline') nonDncLandline++
  })

  let score: number
  if (nonDncMobile >= 3) score = 1.0
  else if (nonDncMobile === 2) score = 0.85
  else if (nonDncMobile === 1) score = nonDncLandline >= 1 ? 0.7 : 0.55
  else score = nonDncLandline >= 1 ? 0.35 : 0.05 // 0 mobile

  return { key: 'reachabilityBonus', score, confidence: 'HIGH' }
}
