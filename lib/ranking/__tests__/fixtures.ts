// Brief 33 — ranking test fixtures (not a *.test.ts). Build AggregatedContact /
// RankingContext with sensible defaults, overridable per case.
import type { AggregatedContact, RankingContext } from '../types'

type AggOver = Partial<Omit<AggregatedContact, 'topMatch' | 'contact'>> & {
  topMatch?: Partial<AggregatedContact['topMatch']>
  contact?: Partial<AggregatedContact['contact']>
}

export function makeAgg(over: AggOver = {}): AggregatedContact {
  const base: AggregatedContact = {
    contactId: 'c1',
    contactType: 'mojoContact',
    topMatch: {
      id: 'm1', matchFit: 70, matchFitConfidence: 'HIGH', captureStatus: 'EXTERNAL_BOTH',
      createdAt: new Date(), contributions: {},
    },
    contributingMatches: [],
    contact: {
      id: 'c1', fullName: 'Test Contact', phone: '(212) 555-0100',
      additionalPhones: [], phoneDncFlags: [false], phoneTypes: ['mobile'],
      lastCalled: null, lastDialDate: null, status: null,
      preForeclosureStatus: null, isVacant: null, neighborhood: null, tags: [], groups: [],
    },
  }
  return {
    ...base,
    ...over,
    topMatch: { ...base.topMatch, ...(over.topMatch ?? {}) },
    contact: { ...base.contact, ...(over.contact ?? {}) },
  }
}

export function makeCtx(over: Partial<RankingContext> = {}): RankingContext {
  return { now: new Date(), ...over }
}
