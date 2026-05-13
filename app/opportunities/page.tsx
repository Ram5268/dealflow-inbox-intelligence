'use client'

import { useEffect, useState, useCallback } from 'react'
import ReadOnlyBanner from '@/components/ReadOnlyBanner'
import OpportunityCard from '@/components/OpportunityCard'
import FilterBar, { Filters } from '@/components/FilterBar'
import { ExtractedOpportunity } from '@prisma/client'

const DEFAULT_FILTERS: Filters = {
  category: '',
  transactionType: '',
  neighborhood: '',
  borough: '',
  minPrice: '',
  maxPrice: '',
  propertyType: '',
  sourceBrokerage: '',
}

export default function OpportunitiesPage() {
  const [opportunities, setOpportunities] = useState<ExtractedOpportunity[]>([])
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v) })

    const res = await fetch(`/api/opportunities?${params}`)
    if (res.ok) {
      const data = await res.json()
      setOpportunities(data.opportunities)
      setTotal(data.total)
    }
    setLoading(false)
  }, [filters])

  useEffect(() => { load() }, [load])

  return (
    <div className="min-h-screen df-bg pb-20">
      <ReadOnlyBanner />
      <div className="px-4 pt-4 pb-2">
        <h1 className="text-xl font-bold" style={{ color: '#fff' }}>Opportunities</h1>
        <p className="text-xs" style={{ color: 'rgba(255,255,255,0.55)' }}>{total} deals extracted from inbox</p>
      </div>

      <FilterBar filters={filters} onChange={setFilters} />

      <div className="px-4 py-3 space-y-3">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-white rounded-xl p-4 h-28 animate-pulse" />
          ))
        ) : opportunities.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <p className="text-4xl mb-2">🏠</p>
            <p className="text-sm font-medium">No opportunities found</p>
            <p className="text-xs mt-1">Try clearing filters or run a sync from the Dashboard.</p>
          </div>
        ) : (
          opportunities.map((opp) => (
            <OpportunityCard key={opp.id} opportunity={opp} />
          ))
        )}
      </div>
    </div>
  )
}
