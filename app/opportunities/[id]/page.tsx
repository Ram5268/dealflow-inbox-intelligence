'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ExtractedOpportunity, RawEmail } from '@prisma/client'
import { CATEGORY_LABELS, TRANSACTION_LABELS, formatPriceRange, timeAgo, confidenceLabel, confidenceColor } from '@/lib/utils'
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
  const SE_LISTABLE_SET = new Set(['ACTIVE_SALE_LISTING','COMING_SOON_SALE','OFF_MARKET_SALE','RENTAL_LISTING','COMING_SOON_RENTAL','DEVELOPMENT_INVENTORY','SPONSOR_UNIT','PRICE_DROP','BACK_ON_MARKET','OPEN_HOUSE','SHOWING_CONFIRMATION','COMING_SOON_DEVELOPMENT'])

  function buildSlugUrl(addr: string, hood: string | null, rental: boolean): string {
    const type = rental ? 'rental' : 'sale'
    const HOOD_BOROUGH: Record<string,string> = {
      williamsburg:'brooklyn',greenpoint:'brooklyn',bushwick:'brooklyn','bed-stuy':'brooklyn','bedford-stuyvesant':'brooklyn','crown heights':'brooklyn','park slope':'brooklyn','carroll gardens':'brooklyn','cobble hill':'brooklyn','boerum hill':'brooklyn','brooklyn heights':'brooklyn',dumbo:'brooklyn','fort greene':'brooklyn','clinton hill':'brooklyn','prospect heights':'brooklyn','red hook':'brooklyn',gowanus:'brooklyn','sunset park':'brooklyn','bay ridge':'brooklyn',flatbush:'brooklyn','ditmas park':'brooklyn',kensington:'brooklyn',midwood:'brooklyn','sheepshead bay':'brooklyn','brighton beach':'brooklyn','coney island':'brooklyn',bensonhurst:'brooklyn',gravesend:'brooklyn','dyker heights':'brooklyn',canarsie:'brooklyn',brownsville:'brooklyn','east new york':'brooklyn','windsor terrace':'brooklyn','south slope':'brooklyn',greenwood:'brooklyn','downtown brooklyn':'brooklyn',
      astoria:'queens','long island city':'queens',lic:'queens',sunnyside:'queens','jackson heights':'queens','forest hills':'queens','rego park':'queens',flushing:'queens',
      riverdale:'bronx',fordham:'bronx','mott haven':'bronx',
    }
    const STREET_TYPES = /\b(street|avenue|boulevard|road|drive|place|court|lane|terrace|circle|parkway|highway|st|ave|blvd|rd|dr|pl|ct|ln|ter|pkwy)\b\.?/gi
    const typeMatches = [...addr.matchAll(STREET_TYPES)]
    let street = addr, unit = ''
    if (typeMatches.length > 0) {
      const last = typeMatches[typeMatches.length - 1]
      const afterType = addr.slice((last.index ?? 0) + last[0].length).trim()
      const rawUnit = afterType.replace(/^(?:apt\.?\s*|unit\s*|#\s*)/i, '').trim()
      const COMPASS = new Set(['south','north','east','west'])
      if (rawUnit && !COMPASS.has(rawUnit.toLowerCase())) {
        street = addr.slice(0, (last.index ?? 0) + last[0].length).trim(); unit = rawUnit
      }
    }
    const borough = HOOD_BOROUGH[(hood ?? '').toLowerCase()] ?? 'new-york'
    const slug = street.toLowerCase().replace(/[.']/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')
    const unitSlug = unit ? `/${unit.toLowerCase().replace(/[^a-z0-9-]/g,'-')}` : ''
    return `https://streeteasy.com/${type}/${slug}-${borough}${unitSlug}`
  }

  const seUrl: string | null = opp.streetEasyId
    ? `https://streeteasy.com/${isRentalCat ? 'rental' : 'sale'}/${opp.streetEasyId}`
    : (() => {
        const bodyM = ((opp.rawEmail.bodyContent ?? '') + ((opp.rawEmail as {attachmentsText?: string|null}).attachmentsText ?? '')).match(/https?:\/\/streeteasy\.com\/[^\s"'<>)\]]+/i)
        if (bodyM) return bodyM[0].replace(/[,\.!?]+$/, '')
        if (opp.address && SE_LISTABLE_SET.has(opp.category)) return buildSlugUrl(opp.address, opp.neighborhood, isRentalCat)
        return null
      })()

  return (
    <div className="df-bg min-h-screen" style={{ minHeight: '100dvh' }}>
      <TopNav />

      {/* Back button */}
      <div style={{ padding: '8px 16px 0' }}>
        <button
          onClick={() => router.push('/chat')}
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
              <a href={seUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'rgba(120,200,220,0.9)' }}>View Listing →</a>
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
