'use client'

import { useEffect, useState } from 'react'
import ReadOnlyBanner from '@/components/ReadOnlyBanner'
import StatCard from '@/components/StatCard'
import OpportunityCard from '@/components/OpportunityCard'
import { CATEGORY_LABELS } from '@/lib/utils'
import { ExtractedOpportunity, Category } from '@prisma/client'

interface DashboardData {
  totalEmails: number
  totalOpportunities: number
  byCategoryRaw: Record<string, number>
  recent: ExtractedOpportunity[]
  lastSync: string | null
}

interface SyncResult {
  ok: boolean
  fetchedCount?: number
  newCount?: number
  processedCount?: number
  relevantCount?: number
  noiseCount?: number
  error?: string
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)

  async function loadData() {
    setLoading(true)
    try {
      const res = await fetch('/api/dashboard')
      if (res.ok) setData(await res.json())
    } finally {
      setLoading(false)
    }
  }

  async function runSync() {
    setSyncing(true)
    setSyncResult(null)
    try {
      const res = await fetch('/api/sync/run', { method: 'POST' })
      const result = await res.json()
      setSyncResult(result)
      if (result.ok) await loadData()
    } finally {
      setSyncing(false)
    }
  }

  useEffect(() => { loadData() }, [])

  const topCategories = data
    ? Object.entries(data.byCategoryRaw)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
    : []

  return (
    <div className="min-h-screen df-bg pb-20">
      <ReadOnlyBanner />
      <div className="px-4 py-4">
        <h1 className="text-xl font-bold text-gray-900 mb-1">DealFlow Inbox</h1>
        <p className="text-xs text-gray-500 mb-4">Read-only deal intelligence from your Outlook inbox</p>

        {loading ? (
          <div className="grid grid-cols-2 gap-3 mb-4">
            {[1, 2].map((i) => (
              <div key={i} className="bg-white rounded-xl p-4 h-20 animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 mb-4">
            <StatCard label="Emails synced" value={data?.totalEmails ?? 0} icon="📧" />
            <StatCard label="Opportunities" value={data?.totalOpportunities ?? 0} icon="🏠" />
          </div>
        )}

        {/* Sync button */}
        <button
          onClick={runSync}
          disabled={syncing}
          className="w-full bg-blue-600 text-white rounded-xl py-3 font-semibold text-sm mb-4 disabled:opacity-60 active:bg-blue-700 transition-colors"
        >
          {syncing ? '⏳ Syncing inbox...' : '🔄 Run Sync Now'}
        </button>

        {syncResult && (
          <div className={`rounded-xl p-3 mb-4 text-sm ${syncResult.ok ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
            {syncResult.ok ? (
              <div className="space-y-1 text-green-800">
                <p className="font-semibold">✅ Sync complete</p>
                <p>Fetched: {syncResult.fetchedCount} • New: {syncResult.newCount} • Relevant: {syncResult.relevantCount} • Noise: {syncResult.noiseCount}</p>
                <p className="text-xs text-green-600">Read-only — no emails modified.</p>
              </div>
            ) : (
              <p className="text-red-700">❌ {syncResult.error}</p>
            )}
          </div>
        )}

        {/* Category breakdown */}
        {topCategories.length > 0 && (
          <div className="mb-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-2">By Category</h2>
            <div className="grid grid-cols-2 gap-2">
              {topCategories.map(([cat, count]) => (
                <div key={cat} className="bg-white rounded-lg px-3 py-2 flex justify-between items-center shadow-sm border border-gray-100">
                  <span className="text-xs text-gray-600">
                    {CATEGORY_LABELS[cat as Category] ?? cat}
                  </span>
                  <span className="text-sm font-bold text-gray-900">{count}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent opportunities */}
        {data?.recent && data.recent.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">Recent Opportunities</h2>
            <div className="space-y-3">
              {data.recent.map((opp) => (
                <OpportunityCard key={opp.id} opportunity={opp} />
              ))}
            </div>
          </div>
        )}

        {!loading && !data?.totalOpportunities && (
          <div className="text-center py-10 text-gray-400">
            <p className="text-4xl mb-2">📬</p>
            <p className="text-sm font-medium">No deals yet</p>
            <p className="text-xs mt-1">Run a sync to pull deals from your inbox, or check demo data in Settings.</p>
          </div>
        )}
      </div>
    </div>
  )
}
