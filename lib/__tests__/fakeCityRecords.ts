// Brief 43 PR 11: a stand-in for fetch, for tests of the city-records lookups
// (lib/acris.ts, lib/dobLookup.ts and their chat side lookups). It answers the
// NYC Open Data datasets those lookups read, from the fixtures below, the way
// Socrata would (simple column filters and `document_id IN (…)`), records every
// URL, and refuses any other address. The OpenAI API (the query parser's
// fallback) gets the reply a test sets. Nothing leaves this process.
//
// Every address, name and figure here is made up ("Marigold Street",
// "Pat Example"); none is a CRM homeowner's.

export interface FakeLegal { document_id: string; borough: string; block: string; lot: string; property_type: string; street_number: string; street_name: string }
export interface FakeMaster { document_id: string; doc_type: string; document_amt: string; recorded_datetime: string; document_date: string }
export interface FakeParty { document_id: string; party_type: string; name: string }

// The same house number and street in two boroughs: the Q16 case.
export const LEGALS: FakeLegal[] = [
  { document_id: 'BK0000000000001', borough: '3', block: '01111', lot: '0011', property_type: '2F', street_number: '418', street_name: 'MARIGOLD STREET' },
  { document_id: 'BK0000000000002', borough: '3', block: '01111', lot: '0011', property_type: '2F', street_number: '418', street_name: 'MARIGOLD STREET' },
  { document_id: 'QN0000000000001', borough: '4', block: '04444', lot: '0044', property_type: '1F', street_number: '418', street_name: 'MARIGOLD STREET' },
  // One address, two tax lots in the same borough (e.g. a split lot).
  { document_id: 'BK0000000000101', borough: '3', block: '02222', lot: '0022', property_type: '3F', street_number: '88', street_name: 'EXAMPLE AVENUE' },
  { document_id: 'BK0000000000102', borough: '3', block: '02222', lot: '0022', property_type: '3F', street_number: '88', street_name: 'EXAMPLE AVENUE' },
  { document_id: 'BK0000000000103', borough: '3', block: '02222', lot: '0023', property_type: '3F', street_number: '88', street_name: 'EXAMPLE AVENUE' },
]

export const MASTER: FakeMaster[] = [
  { document_id: 'BK0000000000001', doc_type: 'DEED', document_amt: '1250000', recorded_datetime: '2019-06-03T00:00:00.000', document_date: '2019-05-20T00:00:00.000' },
  { document_id: 'BK0000000000002', doc_type: 'MTGE', document_amt: '900000', recorded_datetime: '2019-06-03T00:00:00.000', document_date: '2019-05-20T00:00:00.000' },
  { document_id: 'QN0000000000001', doc_type: 'DEED', document_amt: '980000', recorded_datetime: '2021-03-15T00:00:00.000', document_date: '2021-03-01T00:00:00.000' },
  { document_id: 'BK0000000000101', doc_type: 'DEED', document_amt: '1500000', recorded_datetime: '2020-01-10T00:00:00.000', document_date: '2020-01-02T00:00:00.000' },
  { document_id: 'BK0000000000102', doc_type: 'MTGE', document_amt: '1000000', recorded_datetime: '2020-01-10T00:00:00.000', document_date: '2020-01-02T00:00:00.000' },
  { document_id: 'BK0000000000103', doc_type: 'DEED', document_amt: '700000', recorded_datetime: '2022-08-01T00:00:00.000', document_date: '2022-07-20T00:00:00.000' },
]

export const PARTIES: FakeParty[] = [
  { document_id: 'BK0000000000001', party_type: '2', name: 'PAT EXAMPLE' },
  { document_id: 'BK0000000000001', party_type: '1', name: 'JORDAN SAMPLE' },
  { document_id: 'QN0000000000001', party_type: '2', name: 'SAM PLACEHOLDER' },
  { document_id: 'QN0000000000001', party_type: '1', name: 'ALEX FICTIONAL' },
  { document_id: 'BK0000000000101', party_type: '2', name: 'CASEY EXAMPLE' },
  { document_id: 'BK0000000000103', party_type: '2', name: 'ROBIN SAMPLE' },
]

export interface FakeCityRecords {
  /** Every city-records URL fetched, decoded. */
  urls: string[]
  /** Only the URLs for one dataset id (e.g. '8h5j-fqxa'). */
  urlsFor(dataset: string): string[]
  /** The decoded $where of each DOB request, by dataset. */
  whereFor(dataset: string): string[]
  /** Make the next requests to `dataset` fail (HTTP 500) or answer `rows`. */
  set(dataset: string, answer: 'fail' | unknown[] | null): void
  /** The OpenAI reply (the query parser's fallback), as the message content. */
  ai(content: unknown): void
  reset(): void
}

const decode = (u: string) => decodeURIComponent(u.replace(/\+/g, ' '))

export function installFakeCityRecords(): FakeCityRecords {
  const urls: string[] = []
  const overrides = new Map<string, 'fail' | unknown[]>()
  let aiContent: unknown = {}

  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url: string }).url
    if (/^https:\/\/api\.openai\.com\//.test(url)) {
      return new Response(JSON.stringify({
        id: 'chatcmpl-test', object: 'chat.completion', created: 0, model: 'gpt-4o-mini',
        choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: JSON.stringify(aiContent), refusal: null } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const m = url.match(/^https:\/\/data\.cityofnewyork\.us\/resource\/([a-z0-9-]+)\.json\?(.*)$/)
    if (!m) throw new Error(`test: unexpected network call to ${url.split(/[?#]/)[0]}`)
    urls.push(decode(url))
    const [, dataset, qs] = m
    const params = new URLSearchParams(qs)
    const json = (rows: unknown[]) => new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } })

    const override = overrides.get(dataset)
    if (override === 'fail') return new Response('error', { status: 500 })
    if (override) return json(override)

    if (dataset === '8h5j-fqxa') {
      return json(LEGALS.filter(l =>
        l.street_number === params.get('street_number') &&
        l.street_name === params.get('street_name') &&
        (!params.has('borough') || l.borough === params.get('borough'))))
    }
    const ids = [...(params.get('$where') ?? '').matchAll(/'([^']+)'/g)].map(x => x[1])
    if (dataset === 'bnx9-e6tj') return json(MASTER.filter(r => ids.includes(r.document_id)))
    if (dataset === '636b-3b5g') return json(PARTIES.filter(r => ids.includes(r.document_id)))
    // DOB permits / violations: nothing on file unless a test sets rows.
    if (dataset === 'ipu4-2q9a' || dataset === '3h2n-5cm9') return json([])
    throw new Error(`test: unexpected dataset ${dataset}`)
  }) as typeof fetch
  process.env.OPENAI_API_KEY = 'test-only-placeholder'

  return {
    urls,
    urlsFor: (dataset: string) => urls.filter(u => u.includes(`/resource/${dataset}.json`)),
    whereFor: (dataset: string) => urls
      .filter(u => u.includes(`/resource/${dataset}.json`))
      .map(u => u.match(/[?&]\$where=(.*?)(?:&\$limit=|&\$order=|$)/)?.[1] ?? ''),
    set(dataset, answer) { if (answer === null) overrides.delete(dataset); else overrides.set(dataset, answer) },
    ai(content) { aiContent = content },
    reset() { urls.length = 0; overrides.clear(); aiContent = {} },
  }
}
