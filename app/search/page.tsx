'use client'

import { useState, useRef } from 'react'
import ReadOnlyBanner from '@/components/ReadOnlyBanner'
import OpportunityCard from '@/components/OpportunityCard'
import { ExtractedOpportunity } from '@prisma/client'

interface SearchResult extends ExtractedOpportunity {
  matchScore: number
  matchReasons: string[]
}

interface SearchResponse {
  ok: boolean
  query: string
  resultCount: number
  results: SearchResult[]
  note?: string
  error?: string
}

const EXAMPLES = [
  "I have a buyer looking for a 2-3 family up to $2.2M in Bed-Stuy, Clinton Hill, Fort Greene, or similar Brooklyn neighborhoods",
  "Show me all coming soon and off-market listings in Brooklyn",
  "Any buyer ISOs that match a multifamily seller in Crown Heights?",
  "Renter inquiries I can recycle into rental listings",
  "Price drops on condos under $1M in Manhattan",
]

export default function SearchPage() {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState<SearchResponse | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  async function runSearch(q?: string) {
    const searchQuery = q ?? query
    if (!searchQuery.trim()) return
    setLoading(true)
    setResponse(null)
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery }),
      })
      setResponse(await res.json())
    } finally {
      setLoading(false)
    }
  }

  function useExample(example: string) {
    setQuery(example)
    runSearch(example)
  }

  return (
    <div className="min-h-screen df-bg pb-20">
      <ReadOnlyBanner />

      <div className="px-4 pt-4">
        <h1 className="text-xl font-bold text-gray-900 mb-1">Deal Search</h1>
        <p className="text-xs text-gray-500 mb-4">Ask in plain English — results come from your synced inbox data</p>

        <div className="relative mb-3">
          <textarea
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                runSearch()
              }
            }}
            placeholder={'I have a buyer looking for a 2-3 family up to $2.2M in Bed-Stuy, Clinton Hill, Fort Greene, or similar Brooklyn neighborhoods...'}
            rows={3}
            className="w-full rounded-xl border border-gray-200 bg-white p-3 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none"
          />
        </div>

        <button
          onClick={() => runSearch()}
          disabled={loading || !query.trim()}
          className="w-full bg-blue-600 text-white rounded-xl py-3 font-semibold text-sm mb-4 disabled:opacity-60 active:bg-blue-700 transition-colors"
        >
          {loading ? '🔍 Searching...' : '🔍 Search Deals'}
        </button>

        {/* Example queries */}
        {!response && !loading && (
          <div>
            <p className="text-xs text-gray-500 font-medium mb-2">Try an example:</p>
            <div className="space-y-2">
              {EXAMPLES.map((ex, i) => (
                <button
                  key={i}
                  onClick={() => useExample(ex)}
                  className="w-full text-left text-xs bg-white rounded-lg border border-gray-200 px-3 py-2 text-gray-600 hover:bg-gray-50 active:bg-gray-100 transition-colors"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Results */}
        {response && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-gray-700">
                {response.resultCount} {response.resultCount === 1 ? 'match' : 'matches'} found
              </p>
              <button
                onClick={() => setResponse(null)}
                className="text-xs text-blue-600"
              >
                Clear
              </button>
            </div>

            {response.note && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-3 text-sm text-amber-800">
                {response.note}
              </div>
            )}

            {response.error && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-3 mb-3 text-sm text-red-700">
                {response.error}
              </div>
            )}

            <div className="space-y-3">
              {response.results.map((result, i) => (
                <div key={result.id}>
                  <OpportunityCard
                    opportunity={result}
                    matchReasons={result.matchReasons}
                    matchScore={result.matchScore}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
