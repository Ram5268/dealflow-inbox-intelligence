import Link from 'next/link'
import { ExtractedOpportunity } from '@prisma/client'
import {
  CATEGORY_LABELS,
  CATEGORY_COLORS,
  formatPriceRange,
  timeAgo,
  confidenceLabel,
  confidenceColor,
} from '@/lib/utils'

interface OpportunityCardProps {
  opportunity: ExtractedOpportunity
  matchReasons?: string[]
  matchScore?: number
}

export default function OpportunityCard({
  opportunity: opp,
  matchReasons,
}: OpportunityCardProps) {
  const categoryLabel = CATEGORY_LABELS[opp.category] ?? opp.category
  const categoryColor = CATEGORY_COLORS[opp.category] ?? 'bg-gray-100 text-gray-600'

  return (
    <Link href={`/opportunities/${opp.id}`}>
      <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 hover:shadow-md transition-shadow active:bg-gray-50">
        <div className="flex items-start justify-between gap-2 mb-2">
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${categoryColor}`}>
            {categoryLabel}
          </span>
          <span className="text-xs text-gray-400 shrink-0">{timeAgo(opp.createdAt)}</span>
        </div>

        <h3 className="font-semibold text-gray-900 text-sm leading-snug mb-1 line-clamp-2">
          {opp.extractedTitle}
        </h3>

        <p className="text-xs text-gray-500 line-clamp-2 mb-3">{opp.extractedSummary}</p>

        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-600">
          {(opp.price != null || opp.minPrice != null || opp.maxPrice != null) && (
            <span className="font-medium text-gray-900">
              {formatPriceRange(opp.minPrice, opp.maxPrice, opp.price)}
            </span>
          )}
          {opp.neighborhood && (
            <span>📍 {opp.neighborhood}{opp.borough ? `, ${opp.borough}` : ''}</span>
          )}
          {opp.beds != null && <span>{opp.beds}BR</span>}
          {opp.units != null && <span>{opp.units} units</span>}
          {opp.sourceBrokerage && <span className="text-gray-400">{opp.sourceBrokerage}</span>}
        </div>

        <div className="flex items-center justify-between mt-3 pt-2 border-t border-gray-50">
          <span className="text-xs text-gray-400">
            {opp.sourceAgentName ?? 'Unknown sender'}
          </span>
          <span className={`text-xs font-medium ${confidenceColor(opp.confidenceScore)}`}>
            {confidenceLabel(opp.confidenceScore)} confidence
          </span>
        </div>

        {matchReasons && matchReasons.length > 0 && (
          <div className="mt-2 pt-2 border-t border-blue-50">
            <p className="text-xs text-blue-600 font-medium mb-1">Why this matches:</p>
            <ul className="text-xs text-blue-500 space-y-0.5">
              {matchReasons.slice(0, 3).map((r, i) => (
                <li key={i}>• {r}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Link>
  )
}
