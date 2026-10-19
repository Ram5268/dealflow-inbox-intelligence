'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import ChatSurfaceShell from '@/components/ChatSurfaceShell'
import { CATEGORY_LABELS, formatPriceRange } from '@/lib/utils'
import { sendReviewAction } from '@/lib/review/send'

type FlagReason = 'low_confidence' | 'ambiguous_category' | 'missing_address' | 'possible_duplicate'
  | 'conflicting_category' | 'schema_validation_failed' | 'multi_listing_ambiguity'
  | 'missing_date' | 'price_sanity' | 'streeteasy_not_found'

interface ReviewItem {
  id: string
  flagReason: FlagReason
  suggestedAction: string | null
  status: string
  createdAt: string
  opportunity: {
    id: string
    category: string
    address: string | null
    neighborhood: string | null
    borough: string | null
    price: number | null
    minPrice: number | null
    maxPrice: number | null
    beds: number | null
    propertyType: string | null
    extractedTitle: string
    classificationReason: string
    confidenceScore: number
    processingStatus: string
    rawEmail: {
      subject: string
      senderName: string | null
      receivedDateTime: string
      bodyPreview: string | null
      webLink: string | null
    } | null
  } | null
  email: {
    subject: string
    senderName: string | null
    receivedDateTime: string
    bodyPreview: string | null
    webLink: string | null
  } | null
}

const FLAG_LABELS: Record<FlagReason, string> = {
  low_confidence:          'Low confidence',
  ambiguous_category:      'Ambiguous category',
  missing_address:         'Missing address',
  possible_duplicate:      'Possible duplicate',
  conflicting_category:    'Conflicting category',
  schema_validation_failed:'Extraction failed',
  multi_listing_ambiguity: 'Multi-listing',
  missing_date:            'Missing date',
  price_sanity:            'Price issue',
  streeteasy_not_found:    'Not on StreetEasy', // Brief 41.1: a listing an old StreetEasy miss had hidden
}

const FLAG_COLORS: Record<FlagReason, string> = {
  low_confidence:          'rgba(230,200,100,0.85)',
  ambiguous_category:      'rgba(230,200,100,0.85)',
  missing_address:         'rgba(230,140,80,0.85)',
  possible_duplicate:      'rgba(180,160,220,0.85)',
  conflicting_category:    'rgba(230,140,80,0.85)',
  schema_validation_failed:'rgba(220,100,100,0.85)',
  multi_listing_ambiguity: 'rgba(130,200,230,0.85)',
  missing_date:            'rgba(230,140,80,0.85)',
  price_sanity:            'rgba(220,100,100,0.85)',
  streeteasy_not_found:    'rgba(130,200,230,0.85)',
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const h  = Math.floor(ms / 3_600_000)
  if (h < 1)  return `${Math.floor(ms / 60_000)}m ago`
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default function ReviewPage() {
  const router = useRouter()
  const [items, setItems]   = useState<ReviewItem[]>([])
  const [loading, setLoading] = useState(true)
  const [acting, setActing]   = useState<string | null>(null) // item id being actioned
  const [editing, setEditing] = useState<string | null>(null) // item id in correction mode
  const [corrections, setCorrections] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null) // why the last action didn't save

  async function load() {
    setLoading(true)
    const res = await fetch('/api/review?status=pending&limit=50')
    if (res.ok) {
      const data = await res.json()
      setItems(data.items ?? [])
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function act(itemId: string, action: string, corrs?: Record<string, string>, notes?: string) {
    setActing(itemId)
    setFailure(null)
    // Brief 48 (PR 3): the reply is read now. A refused or failed save keeps the
    // item, the open form and what Ryan typed, with the server's message under it.
    const problem = await sendReviewAction({ id: itemId, action, corrections: corrs, notes })
    setActing(null)
    if (problem) {
      setFailure({ id: itemId, message: problem })
      return
    }
    setEditing(null)
    setCorrections({})
    setItems(prev => prev.filter(i => i.id !== itemId))
  }

  if (loading) {
    return (
      <ChatSurfaceShell>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.35)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          Loading…
        </div>
      </ChatSurfaceShell>
    )
  }

  if (items.length === 0) {
    return (
      <ChatSurfaceShell>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.18em', color: 'rgba(255,255,255,0.35)' }}>REVIEW QUEUE</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, color: 'rgba(255,255,255,0.6)', fontWeight: 300 }}>Queue is clear.</div>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'rgba(255,255,255,0.3)', marginTop: 6 }}>No flagged extractions pending review.</div>
        </div>
      </ChatSurfaceShell>
    )
  }

  return (
    <ChatSurfaceShell>
      <div style={{ padding: '0 16px 4px' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.18em', color: 'rgba(255,255,255,0.45)' }}>
          REVIEW QUEUE · {items.length} PENDING
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: '8px 16px 80px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {items.map(item => {
          const opp   = item.opportunity
          const email = item.email ?? opp?.rawEmail
          const isEditing  = editing === item.id
          const isActing   = acting  === item.id
          const flagColor  = FLAG_COLORS[item.flagReason] ?? 'rgba(255,255,255,0.55)'

          return (
            <div
              key={item.id}
              className="sr-anim-up"
              style={{
                borderRadius: 18,
                background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.12)',
                backdropFilter: 'blur(20px) saturate(160%)',
                WebkitBackdropFilter: 'blur(20px) saturate(160%)',
                padding: '16px 18px',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              {/* Header row */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                    <span style={{
                      fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.14em',
                      color: flagColor,
                      background: `${flagColor.replace('0.85', '0.12')}`,
                      border: `1px solid ${flagColor.replace('0.85', '0.3')}`,
                      borderRadius: 999, padding: '2px 8px',
                    }}>
                      {FLAG_LABELS[item.flagReason] ?? item.flagReason}
                    </span>
                    {opp && (
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.14em', color: 'rgba(255,255,255,0.4)' }}>
                        {((CATEGORY_LABELS as Record<string, string>)[opp.category] ?? opp.category).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 400, color: '#fff', lineHeight: 1.2 }}>
                    {opp?.extractedTitle ?? email?.subject ?? '(unknown)'}
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 3 }}>
                    {email?.senderName ?? 'Unknown'} · {email ? timeAgo(email.receivedDateTime) : ''}
                  </div>
                </div>
                {opp && (
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(255,255,255,0.55)', flexShrink: 0, textAlign: 'right' }}>
                    <div>{Math.round(opp.confidenceScore * 100)}%</div>
                    <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)' }}>conf</div>
                  </div>
                )}
              </div>

              {/* Extracted fields */}
              {opp && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'rgba(255,255,255,0.7)' }}>
                  {opp.address && <span>{opp.address}</span>}
                  {(opp.price != null || opp.maxPrice != null) && (
                    <span>{formatPriceRange(opp.minPrice, opp.maxPrice, opp.price)}</span>
                  )}
                  {opp.beds != null && <span>{opp.beds}BR</span>}
                  {opp.neighborhood && <span style={{ color: 'rgba(255,255,255,0.45)' }}>{opp.neighborhood}</span>}
                </div>
              )}

              {/* AI reason */}
              {opp?.classificationReason && (
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'rgba(255,255,255,0.5)', lineHeight: 1.45, borderTop: '0.5px solid rgba(255,255,255,0.08)', paddingTop: 8 }}>
                  <span style={{ color: 'rgba(255,255,255,0.3)' }}>AI: </span>{opp.classificationReason}
                </div>
              )}

              {/* Email preview */}
              {email?.bodyPreview && (
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'rgba(255,255,255,0.38)', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {email.bodyPreview}
                </div>
              )}

              {/* Suggested action */}
              {item.suggestedAction && (
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'rgba(130,200,230,0.7)', lineHeight: 1.4 }}>
                  {item.suggestedAction}
                </div>
              )}

              {/* Correction form */}
              {isEditing && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '0.5px solid rgba(255,255,255,0.12)', paddingTop: 10 }}>
                  {(['address', 'price', 'beds', 'neighborhood'] as const).map(field => (
                    <div key={field} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <label style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.12em', color: 'rgba(255,255,255,0.4)', width: 90, flexShrink: 0 }}>
                        {field.toUpperCase()}
                      </label>
                      <input
                        value={corrections[field] ?? (opp?.[field as keyof typeof opp] as string ?? '')}
                        onChange={e => setCorrections(prev => ({ ...prev, [field]: e.target.value }))}
                        placeholder={`Edit ${field}…`}
                        style={{
                          flex: 1, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.18)',
                          borderRadius: 8, padding: '6px 10px', color: '#fff',
                          fontFamily: 'var(--font-ui)', fontSize: 16, outline: 'none',
                        }}
                      />
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                    <button
                      onClick={() => act(item.id, 'correct', corrections)}
                      disabled={isActing}
                      style={{ flex: 1, background: '#fff', color: '#0a1f2a', border: 'none', borderRadius: 999, padding: '9px 0', fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 500, cursor: 'pointer' }}
                    >
                      Save corrections
                    </button>
                    <button
                      onClick={() => { setEditing(null); setCorrections({}); setFailure(null) }}
                      style={{ flex: 0.6, background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.6)', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 999, padding: '9px 0', fontFamily: 'var(--font-ui)', fontSize: 12, cursor: 'pointer' }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Action buttons */}
              {!isEditing && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                  <ActionBtn label="Approve"    disabled={isActing} color="rgba(120,220,150,0.9)" onClick={() => act(item.id, 'approve')} />
                  {/* Brief 48 (PR 3): a fresh form, so another item's typing never carries over */}
                  <ActionBtn label="Correct"    disabled={isActing} color="rgba(130,200,230,0.9)" onClick={() => { setEditing(item.id); setCorrections({}); setFailure(null) }} />
                  <ActionBtn label="Reject"     disabled={isActing} color="rgba(220,100,100,0.8)" onClick={() => act(item.id, 'reject')} />
                  <ActionBtn label="Duplicate"  disabled={isActing} color="rgba(180,160,220,0.8)" onClick={() => act(item.id, 'mark_duplicate')} />
                  <ActionBtn label="Stale"      disabled={isActing} color="rgba(255,255,255,0.4)" onClick={() => act(item.id, 'mark_stale')} />
                  {email?.webLink && (
                    <a
                      href={email.webLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.1em', color: 'rgba(255,255,255,0.35)', padding: '6px 12px', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 999, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
                    >
                      Outlook →
                    </a>
                  )}
                  {opp && (
                    <button
                      onClick={() => router.push(`/opportunities/${opp.id}`)}
                      style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.1em', color: 'rgba(255,255,255,0.35)', padding: '6px 12px', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 999, background: 'none', cursor: 'pointer' }}
                    >
                      Detail →
                    </button>
                  )}
                </div>
              )}

              {/* Brief 48 (PR 3): why the last action on this item didn't save, under the form or the buttons */}
              {failure?.id === item.id && (
                <div role="alert" style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'rgba(240,190,120,0.95)', lineHeight: 1.45 }}>
                  {failure.message}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </ChatSurfaceShell>
  )
}

function ActionBtn({ label, color, onClick, disabled }: { label: string; color: string; onClick: () => void; disabled: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.1em',
        color,
        background: color.replace(/[\d.]+\)$/, '0.10)'),
        border: `1px solid ${color.replace(/[\d.]+\)$/, '0.28)')}`,
        borderRadius: 999, padding: '6px 12px',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  )
}
