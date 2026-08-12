'use client'

import { CATEGORY_LABELS, TRANSACTION_LABELS } from '@/lib/utils'

export interface Filters {
  category: string
  transactionType: string
  neighborhood: string
  borough: string
  minPrice: string
  maxPrice: string
  propertyType: string
  sourceBrokerage: string
}

interface FilterBarProps {
  filters: Filters
  onChange: (filters: Filters) => void
}

const BOROUGHS = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island']

export default function FilterBar({ filters, onChange }: FilterBarProps) {
  const set = (key: keyof Filters, value: string) =>
    onChange({ ...filters, [key]: value })

  const selectClass =
    'w-full text-xs rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-400'

  return (
    <div className="bg-gray-50 border-b border-gray-200 p-3">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-gray-500 mb-0.5">Category</label>
          <select
            className={selectClass}
            value={filters.category}
            onChange={(e) => set('category', e.target.value)}
          >
            <option value="">All categories</option>
            {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-0.5">Type</label>
          <select
            className={selectClass}
            value={filters.transactionType}
            onChange={(e) => set('transactionType', e.target.value)}
          >
            <option value="">All types</option>
            {Object.entries(TRANSACTION_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-0.5">Borough</label>
          <select
            className={selectClass}
            value={filters.borough}
            onChange={(e) => set('borough', e.target.value)}
          >
            <option value="">All boroughs</option>
            {BOROUGHS.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-0.5">Neighborhood</label>
          <input
            type="text"
            placeholder="e.g. Bed-Stuy"
            className={selectClass}
            value={filters.neighborhood}
            onChange={(e) => set('neighborhood', e.target.value)}
          />
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-0.5">Max Price</label>
          <input
            type="number"
            placeholder="e.g. 2200000"
            className={selectClass}
            value={filters.maxPrice}
            onChange={(e) => set('maxPrice', e.target.value)}
          />
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-0.5">Property Type</label>
          <input
            type="text"
            placeholder="e.g. 2-family"
            className={selectClass}
            value={filters.propertyType}
            onChange={(e) => set('propertyType', e.target.value)}
          />
        </div>
      </div>
    </div>
  )
}
