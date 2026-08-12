'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ExtractedOpportunity, RawEmail } from '@prisma/client'
import { CATEGORY_LABELS, TRANSACTION_LABELS, formatPriceRange, timeAgo, confidenceLabel } from '@/lib/utils'
import TopNav from '@/components/TopNav'

type OppWithEmail = ExtractedOpportunity & { rawEmail: RawEmail }

export default function OpportunityDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [opp, setOpp] = useState<OppWithEmail | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`/api/opportunities/${id}`).then(r => r.json()).then(setOpp).finally(() => setLoading(false))
  }, [id])

  const Field = ({ label, value }: { label: string; value: string | number | null | undefined }) =>
    value != null ? (
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: 13 }}>
        <span style={{ color: 'rgba(255,255,255,0.45)' }}>{label}</span>
        <span style={{ color: 'rgba(255,255,255,0.85)', fontWeight: 500, textAlign: 'right', maxWidth: '60%' }}>{String(value)}</span>
      </div>
    ) : null

  if (loading) return (
    <div className="df-bg min-h-screen flex items-center justify-center" style={{ minHeight: '100dvh' }}>
      <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 14 }}>Loading...</div>
    </div>
  )

  if (!opp) return (
    <div className="df-bg min-h-screen flex flex-col items-center justify-center" style={{ minHeight: '100dvh' }}>
      <p style={{ color: 'rgba(255,255,255,0.5)', marginBottom: 16 }}>Opportunity not found.</p>
      <button onClick={() => router.back()} style={{ color: 'rgba(255,255,255,0.5)', fontSize: 14 }}>← Back</button>
    </div>
  )

  const categoryLabel = CATEGORY_LABELS[opp.category] ?? opp.category
  const isRentalCat = ['RENTAL_LISTING','COMING_SOON_RENTAL'].includes(opp.category)
  // seUrl: direct listing if streetEasyId is set, else search fallback
  // FIXME phase-C-or-later: 4th copy of the borough-from-neighborhood lookup, missed by
  // Phase B because it's in a client component. Importing lib/domain/Neighborhood here
  // would ship the entire 215-entry NEIGHBORHOODS map to the browser. Phase C should
  // expose a lightweight client-safe helper (e.g. a server action that returns just the
  // borough slug) so this inline map can go away without bloating the client bundle.
  const HOOD_TO_BOROUGH_DETAIL: Record<string,string> = { williamsburg:'brooklyn',greenpoint:'brooklyn',bushwick:'brooklyn','bed-stuy':'brooklyn','crown heights':'brooklyn','park slope':'brooklyn','carroll gardens':'brooklyn','cobble hill':'brooklyn','boerum hill':'brooklyn','brooklyn heights':'brooklyn',dumbo:'brooklyn','fort greene':'brooklyn','clinton hill':'brooklyn','prospect heights':'brooklyn','red hook':'brooklyn',gowanus:'brooklyn','sunset park':'brooklyn','bay ridge':'brooklyn',flatbush:'brooklyn','ditmas park':'brooklyn','sheepshead bay':'brooklyn','brighton beach':'brooklyn','coney island':'brooklyn',greenwood:'brooklyn','downtown brooklyn':'brooklyn',astoria:'queens','long island city':'queens',sunnyside:'queens','jackson heights':'queens','forest hills':'queens','rego park':'queens',flushing:'queens',riverdale:'bronx',fordham:'bronx','mott haven':'bronx' }
  const seDirectUrl: string | null = opp.streetEasyId
    ? (opp.streetEasyId.includes('/') ? `https://www.streeteasy.com/${opp.streetEasyId}` : `https://www.streeteasy.com/${isRentalCat ? 'rental' : 'sale'}/${opp.streetEasyId}`)
    : (() => {
        const bodyM = ((opp.rawEmail.bodyContent ?? '') + ((opp.rawEmail as {attachmentsText?: string|null}).attachmentsText ?? '')).match(/https?:\/\/streeteasy\.com\/[^\s"'<>)\]]+/i)
        return bodyM ? bodyM[0].replace(/[,\.!?]+$/, '') : null
      })()
  const seSearchUrl: string | null = (!seDirectUrl && opp.address && ['ACTIVE_SALE_LISTING','COMING_SOON_SALE','OFF_MARKET_SALE','RENTAL_LISTING','COMING_SOON_RENTAL','DEVELOPMENT_INVENTORY','SPONSOR_UNIT','PRICE_DROP','BACK_ON_MARKET','OPEN_HOUSE'].includes(opp.category))
    ? (() => {
        const borough = HOOD_TO_BOROUGH_DETAIL[(opp.neighborhood ?? '').toLowerCase()] ?? 'new-york'
        const bp = borough === 'new-york' ? 'manhattan' : borough
        return `https://www.streeteasy.com/for-${isRentalCat ? 'rent' : 'sale'}/${bp}?q=${encodeURIComponent(opp.address!)}`
      })()
    : null
  const seUrl = seDirectUrl ?? seSearchUrl
  const seLabel = seDirectUrl ? 'View Listing →' : 'Search StreetEasy →'

  return (
    <div className="df-bg min-h-screen" style={{ minHeight: '100dvh' }}>
      <TopNav />

      {/* Back button */}
      <div style={{ padding: '8px 16px 0' }}>
        <button
          onClick={() => {
            // If we arrived from a chat results view, go back to that exact
            // session + re-raise the results cards (via ?deal=<id>). Otherwise
            // fall back to normal history-back (e.g. from the opportunities list).
            const from = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('from') : null
            if (from) router.push(`/chat?sessionId=${from}&deal=${id}`)
            else router.back()
          }}
          style={{ background: 'rgba(255,255,255,0.1)', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: '50%' } as React.CSSProperties}
          aria-label="Back"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      </div>

      <div style={{ padding: '0 16px 48px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Title */}
        <div>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600 }}>{categoryLabel} · {timeAgo(opp.createdAt)}</span>
          <h1 style={{ fontFamily: 'var(--font-playfair)', fontSize: 22, fontWeight: 600, color: '#fff', marginTop: 6, lineHeight: 1.3 }}>{opp.extractedTitle}</h1>
          <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.55)', marginTop: 6, lineHeight: 1.5 }}>{opp.extractedSummary}</p>
        </div>

        {/* Details */}
        <div className="df-card" style={{ padding: '16px 20px' }}>
          <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8, fontWeight: 600 }}>Details</p>
          <Field label="Transaction" value={TRANSACTION_LABELS[opp.transactionType] ?? opp.transactionType} />
          <Field label="Property type" value={opp.propertyType} />
          <Field label="Price" value={formatPriceRange(opp.minPrice, opp.maxPrice, opp.price) === '—' ? null : formatPriceRange(opp.minPrice, opp.maxPrice, opp.price)} />
          <Field label="Beds" value={opp.beds} />
          <Field label="Baths" value={opp.baths} />
          <Field label="Units" value={opp.units} />
          <Field label="Sq ft" value={opp.squareFeet} />
          <Field label="Address" value={opp.address} />
          <Field label="Neighborhood" value={opp.neighborhood} />
          <Field label="Borough" value={opp.borough} />
          <Field label="Availability" value={opp.availabilityDate} />
          <Field label="Status" value={opp.status} />
          <Field label="Client side" value={opp.clientSide} />
        </div>

        {/* Source */}
        <div className="df-card" style={{ padding: '16px 20px' }}>
          <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8, fontWeight: 600 }}>Source</p>
          <Field label="Agent" value={opp.sourceAgentName} />
          <Field label="Email" value={opp.sourceAgentEmail} />
          <Field label="Brokerage" value={opp.sourceBrokerage} />
          <Field label="Subject" value={opp.rawEmail.subject} />
          <Field label="Sender" value={opp.rawEmail.senderName} />
          <Field label="Received" value={new Date(opp.rawEmail.receivedDateTime).toLocaleDateString()} />
          {seUrl && (
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', fontSize: 13 }}>
              <span style={{ color: 'rgba(255,255,255,0.45)' }}>StreetEasy</span>
              <a href={seUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'rgba(120,200,220,0.9)' }}>{seLabel}</a>
            </div>
          )}
          {opp.rawEmail.webLink && (
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', fontSize: 13 }}>
              <span style={{ color: 'rgba(255,255,255,0.45)' }}>View in Outlook</span>
              <a href={opp.rawEmail.webLink} target="_blank" rel="noopener noreferrer" style={{ color: 'rgba(120,200,220,0.9)' }}>Open →</a>
            </div>
          )}
        </div>

        {/* Preview */}
        {opp.rawEmail.bodyPreview && (
          <div className="df-card" style={{ padding: '16px 20px' }}>
            <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8, fontWeight: 600 }}>Email Preview</p>
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.65)', lineHeight: 1.6 }}>{opp.rawEmail.bodyPreview}</p>
          </div>
        )}

        {/* Classification */}
        <div className="df-card" style={{ padding: '16px 20px' }}>
          <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8, fontWeight: 600 }}>AI Classification</p>
          <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.65)', lineHeight: 1.5, marginBottom: 10 }}>{opp.classificationReason}</p>
          <span style={{ fontSize: 12, color: opp.confidenceScore >= 0.85 ? 'rgba(150,230,170,0.9)' : opp.confidenceScore >= 0.6 ? 'rgba(230,200,100,0.9)' : 'rgba(230,130,130,0.9)' }}>
            {confidenceLabel(opp.confidenceScore)} confidence · {Math.round(opp.confidenceScore * 100)}%
          </span>
        </div>

        <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.18)', textAlign: 'center' }}>
          🔒 Read-only · Graph ID: {opp.rawEmail.graphMessageId.slice(0, 20)}...
        </p>
      </div>
    </div>
  )
}
