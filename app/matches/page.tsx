'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import ChatSurfaceShell from '@/components/ChatSurfaceShell'
import GooeyFilter from '@/components/GooeyFilter'
import { formatPriceRange, timeAgo } from '@/lib/utils'

// ── Types mirror /api/matches GET response shape ─────────────────────────────
interface PrimaryOpp {
  id: string
  category: string
  address: string | null
  neighborhood: string | null
  price: number | null
  minPrice: number | null
  maxPrice: number | null
  beds: number | null
  propertyType: string | null
  units: number | null
  sourceAgentName: string | null
  sourceBrokerage: string | null
  extractedTitle: string
  extractedSummary: string
}

interface CounterpartOpp {
  id: string
  category: string
  address: string | null
  neighborhood: string | null
  price: number | null
  minPrice: number | null
  maxPrice: number | null
  beds: number | null
  sourceAgentName: string | null
  sourceBrokerage: string | null
  extractedTitle: string
  extractedSummary: string
}

interface CounterpartMojo {
  id: string
  fullName: string
  address: string | null
  city: string | null
  neighborhood: string | null
  phone: string | null
  email: string | null
  status: string | null
  notes: string | null
}

interface Match {
  id: string
  score: number
  reason: string | null
  counterpartType: string
  seen: boolean
  createdAt: string
  primary: PrimaryOpp | null
  counterpart: CounterpartOpp | CounterpartMojo | null
}

interface MatchesResponse {
  matches: Match[]
  counts: { total: number; unseen: number; mojo: number; listings: number; showings: number }
}

// ── Row format helpers ───────────────────────────────────────────────────────
function typeBadge(m: Match): { text: string; tone: string } {
  if (m.counterpartType === 'mojo')                 return { text: '🔥 MOJO ↔ BUYER', tone: 'rgba(230,140,80,0.95)' }
  if (m.counterpartType === 'showing_confirmation') return { text: '🗓 SHOWING',       tone: 'rgba(130,200,230,0.9)' }
  return { text: 'LISTING ↔ BUYER', tone: 'rgba(255,255,255,0.55)' }
}

function primaryLabel(p: PrimaryOpp | null): string {
  if (!p) return '(missing opportunity)'
  return p.address ?? p.extractedTitle
}

function counterpartLabel(m: Match): string {
  if (!m.counterpart) return ''
  if (m.counterpartType === 'mojo') {
    const c = m.counterpart as CounterpartMojo
    return c.fullName
  }
  const c = m.counterpart as CounterpartOpp
  return c.sourceAgentName
    ? `${c.sourceAgentName}${c.sourceBrokerage ? ' @ ' + c.sourceBrokerage : ''}`
    : (c.address ?? c.extractedTitle)
}

function contextLine(m: Match): string {
  if (m.counterpartType === 'showing_confirmation') return m.reason ?? ''
  const p = m.primary
  const c = m.counterpart
  if (!p) return ''
  const pBit = `${formatPriceRange(p.minPrice, p.maxPrice, p.price)}${p.beds ? ` ${p.beds}BR` : ''}${p.neighborhood ? ` ${p.neighborhood}` : ''}`.trim()
  if (!c) return pBit
  if (m.counterpartType === 'mojo') {
    const mc = c as CounterpartMojo
    return `${pBit} ↔ ${mc.address ?? mc.city ?? 'Mojo lead'}`
  }
  const oc = c as CounterpartOpp
  const cBit = `${formatPriceRange(oc.minPrice, oc.maxPrice, oc.price)}${oc.beds ? ` ${oc.beds}BR` : ''}${oc.neighborhood ? ` ${oc.neighborhood}` : ''}`.trim()
  return `${pBit} ↔ ${cBit}`
}

// ── Page ────────────────────────────────────────────────────────────────────
export default function MatchesPage() {
  const router = useRouter()
  const [data, setData] = useState<MatchesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [runResult, setRunResult] = useState<string | null>(null)

  type ScoreBand  = 'gold' | 'strong' | 'all'
  type TypeFilter = 'all' | 'opportunity' | 'mojo' | 'showing_confirmation'

  const [scoreBand,  setScoreBand]  = useState<ScoreBand>('strong')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [unseenOnly, setUnseenOnly] = useState<boolean>(true)

  const scoreMin: number | null =
    scoreBand === 'gold'   ? 90 :
    scoreBand === 'strong' ? 70 :
    null

  async function fetchMatches() {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (unseenOnly)           params.set('unseen',   '1')
      if (scoreMin !== null)    params.set('scoreMin', String(scoreMin))
      if (typeFilter !== 'all') params.set('type',     typeFilter)
      const r = await fetch(`/api/matches?${params.toString()}`)
      const j = await r.json() as MatchesResponse
      setData(j)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void fetchMatches() }, [scoreBand, typeFilter, unseenOnly])

  async function runMatchmaker() {
    setRunning(true)
    setRunResult(null)
    try {
      const r = await fetch('/api/matches/run-matchmaker', { method: 'POST' })
      const j = await r.json() as { newMatches: number; highConfidence: number; processed: number }
      setRunResult(`+${j.newMatches} new (${j.highConfidence} high-confidence) across ${j.processed} opportunities`)
      await fetchMatches()
    } catch {
      setRunResult('Matchmaker failed — try again.')
    } finally {
      setRunning(false)
    }
  }

  function toggleExpand(m: Match) {
    if (expandedId === m.id) {
      setExpandedId(null)
      return
    }
    setExpandedId(m.id)
    // Background mark-seen on first expand. Optimistic local update.
    if (!m.seen) {
      void fetch('/api/matches', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id: m.id }),
      })
      setData(d => d ? {
        ...d,
        matches: d.matches.map(x => x.id === m.id ? { ...x, seen: true } : x),
        counts:  { ...d.counts, unseen: Math.max(0, d.counts.unseen - 1) },
      } : d)
    }
  }

  return (
    <ChatSurfaceShell>
      <GooeyFilter id="goo-filter" strength={8} />

      <div style={{ padding: '0 16px 10px' }}>
        <div
          style={{
            filter: 'url(#goo-filter)',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            padding: '4px 0',
          }}
        >
          <Chip label="GOLD 90+"   active={scoreBand === 'gold'}   onClick={() => setScoreBand('gold')}   />
          <Chip label="STRONG 70+" active={scoreBand === 'strong'} onClick={() => setScoreBand('strong')} />
          <Chip label="ALL 50+"    active={scoreBand === 'all'}    onClick={() => setScoreBand('all')}    />
          <Spacer />
          <Chip label="ALL TYPES" active={typeFilter === 'all'}                  onClick={() => setTypeFilter('all')} />
          <Chip label="LISTINGS"  active={typeFilter === 'opportunity'}          onClick={() => setTypeFilter('opportunity')} />
          <Chip label="🔥 MOJO"   active={typeFilter === 'mojo'}                 onClick={() => setTypeFilter('mojo')} />
          <Chip label="SHOWINGS"  active={typeFilter === 'showing_confirmation'} onClick={() => setTypeFilter('showing_confirmation')} />
          <Spacer />
          <Chip label={unseenOnly ? 'UNSEEN ONLY' : 'INCL. SEEN'} active={unseenOnly} onClick={() => setUnseenOnly(v => !v)} />
        </div>
      </div>

      <div style={{ padding: '0 16px 4px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 4 }}>
          <div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.18em', color: 'rgba(255,255,255,0.45)' }}>
              MATCHES
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.14em', color: 'rgba(255,255,255,0.35)', marginTop: 4 }}>
              {data
                ? `${data.counts.unseen} UNSEEN · ${data.counts.mojo} MOJO · ${data.counts.listings} LISTINGS · ${data.counts.showings} SHOWINGS`
                : 'LOADING…'}
            </div>
          </div>
          <button
            onClick={runMatchmaker}
            disabled={running}
            style={{
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              letterSpacing: '0.12em',
              color: running ? 'rgba(255,255,255,0.35)' : 'var(--sr-cream)',
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 999,
              padding: '6px 14px',
              cursor: running ? 'wait' : 'pointer',
            }}
          >
            {running ? 'RUNNING…' : 'RUN MATCHMAKER ↻'}
          </button>
        </div>
        {runResult && (
          <div style={{ marginTop: 8, fontSize: 12, color: '#7dd3a8', fontFamily: 'var(--font-mono)' }}>
            {runResult}
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: '12px 16px 80px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {loading ? (
          <div style={{ color: 'rgba(255,255,255,0.35)', fontSize: 12, fontFamily: 'var(--font-mono)', textAlign: 'center', marginTop: 40 }}>
            Loading…
          </div>
        ) : !data || data.matches.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 40 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, color: 'rgba(255,255,255,0.6)', fontWeight: 300 }}>No matches yet.</div>
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'rgba(255,255,255,0.3)' }}>Tap RUN MATCHMAKER ↻ above to scan recent opportunities.</div>
          </div>
        ) : (
          data.matches.map(m => {
            const badge       = typeBadge(m)
            const isExpanded  = expandedId === m.id
            const primaryStr  = primaryLabel(m.primary)
            const counterStr  = counterpartLabel(m)
            const ctxStr      = contextLine(m)

            return (
              <div
                key={m.id}
                onClick={() => toggleExpand(m)}
                className="sr-anim-up"
                style={{
                  borderRadius: 16,
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  backdropFilter: 'blur(20px) saturate(160%)',
                  WebkitBackdropFilter: 'blur(20px) saturate(160%)',
                  padding: '12px 16px',
                  cursor: 'pointer',
                  opacity: m.seen ? 0.55 : 1,
                  transition: 'opacity 200ms',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.12em' }}>
                  <span style={{ color: badge.tone }}>{badge.text} · SCORE {m.score}</span>
                  <span style={{ color: 'rgba(255,255,255,0.4)' }}>{isExpanded ? '▾' : '→'}</span>
                </div>
                <div style={{ marginTop: 6, fontSize: 14, color: '#fff', fontWeight: 500, lineHeight: 1.35 }}>
                  {primaryStr}{counterStr ? <span style={{ color: 'rgba(255,255,255,0.55)', fontWeight: 400 }}>{' ↔ '}{counterStr}</span> : null}
                </div>
                {ctxStr && (
                  <div style={{ marginTop: 3, fontSize: 12, color: 'rgba(255,255,255,0.5)', lineHeight: 1.4 }}>{ctxStr}</div>
                )}
                {isExpanded && (
                  <ExpandedDetail m={m} router={router} />
                )}
              </div>
            )
          })
        )}
      </div>
    </ChatSurfaceShell>
  )
}

// ── Expanded paired-detail block ────────────────────────────────────────────
function ExpandedDetail({ m, router }: { m: Match; router: ReturnType<typeof useRouter> }) {
  const isMojo    = m.counterpartType === 'mojo'
  const isShowing = m.counterpartType === 'showing_confirmation'

  function go(e: React.MouseEvent, path: string) {
    e.stopPropagation()
    router.push(path)
  }

  return (
    <div
      onClick={e => e.stopPropagation()}
      style={{
        marginTop: 12,
        paddingTop: 12,
        borderTop: '1px solid rgba(255,255,255,0.08)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {m.reason && (
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', lineHeight: 1.5, fontStyle: 'italic' }}>
          {m.reason}
        </div>
      )}

      {/* Primary side */}
      {m.primary && (
        <Side
          label="LISTING"
          title={m.primary.extractedTitle}
          subtitle={m.primary.address ?? m.primary.neighborhood ?? ''}
          meta={[
            formatPriceRange(m.primary.minPrice, m.primary.maxPrice, m.primary.price),
            m.primary.beds ? `${m.primary.beds}BR` : null,
            m.primary.units ? `${m.primary.units}-unit` : null,
            m.primary.propertyType,
          ].filter(Boolean).join(' · ')}
          source={m.primary.sourceAgentName ? `${m.primary.sourceAgentName}${m.primary.sourceBrokerage ? ' @ ' + m.primary.sourceBrokerage : ''}` : null}
          onOpen={e => go(e, `/opportunities/${m.primary!.id}`)}
          openLabel="Open listing →"
        />
      )}

      {/* Counterpart side */}
      {!isShowing && m.counterpart && (isMojo ? (
        <MojoSide c={m.counterpart as CounterpartMojo} />
      ) : (
        <Side
          label="BUYER"
          title={(m.counterpart as CounterpartOpp).extractedTitle}
          subtitle={(m.counterpart as CounterpartOpp).address ?? (m.counterpart as CounterpartOpp).neighborhood ?? ''}
          meta={[
            formatPriceRange((m.counterpart as CounterpartOpp).minPrice, (m.counterpart as CounterpartOpp).maxPrice, (m.counterpart as CounterpartOpp).price),
            (m.counterpart as CounterpartOpp).beds ? `${(m.counterpart as CounterpartOpp).beds}BR` : null,
          ].filter(Boolean).join(' · ')}
          source={(m.counterpart as CounterpartOpp).sourceAgentName ? `${(m.counterpart as CounterpartOpp).sourceAgentName}${(m.counterpart as CounterpartOpp).sourceBrokerage ? ' @ ' + (m.counterpart as CounterpartOpp).sourceBrokerage : ''}` : null}
          onOpen={e => go(e, `/opportunities/${(m.counterpart as CounterpartOpp).id}`)}
          openLabel="View buyer side →"
        />
      ))}

      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', fontFamily: 'var(--font-mono)', letterSpacing: '0.1em' }}>
        MATCHED {timeAgo(m.createdAt)}
      </div>
    </div>
  )
}

function Side({
  label, title, subtitle, meta, source, onOpen, openLabel,
}: {
  label: string
  title: string
  subtitle: string
  meta: string
  source: string | null
  onOpen: (e: React.MouseEvent) => void
  openLabel: string
}) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: '10px 12px' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.14em', color: 'rgba(255,255,255,0.45)' }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 13, color: '#fff', fontWeight: 500 }}>{title}</div>
      {subtitle && <div style={{ marginTop: 2, fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>{subtitle}</div>}
      {meta && <div style={{ marginTop: 4, fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>{meta}</div>}
      {source && <div style={{ marginTop: 4, fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{source}</div>}
      <button
        onClick={onOpen}
        style={{
          marginTop: 8,
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.1em',
          color: 'var(--sr-cream)',
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
        }}
      >
        {openLabel}
      </button>
    </div>
  )
}

function MojoSide({ c }: { c: CounterpartMojo }) {
  return (
    <div style={{ background: 'rgba(230,140,80,0.08)', borderRadius: 12, padding: '10px 12px', border: '1px solid rgba(230,140,80,0.18)' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.14em', color: 'rgba(230,140,80,0.95)' }}>🔥 MOJO SELLER LEAD</div>
      <div style={{ marginTop: 4, fontSize: 13, color: '#fff', fontWeight: 500 }}>{c.fullName}</div>
      {c.address && <div style={{ marginTop: 2, fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>{c.address}{c.city ? `, ${c.city}` : ''}</div>}
      {c.neighborhood && !c.address && <div style={{ marginTop: 2, fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>{c.neighborhood}</div>}
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
        {c.phone && (
          <a href={`tel:${c.phone}`} onClick={e => e.stopPropagation()} style={{ color: 'rgba(120,200,220,0.95)' }}>📞 {c.phone}</a>
        )}
        {c.email && (
          <a href={`mailto:${c.email}`} onClick={e => e.stopPropagation()} style={{ color: 'rgba(120,200,220,0.95)' }}>✉️ {c.email}</a>
        )}
      </div>
      {c.notes && <div style={{ marginTop: 6, fontSize: 11, color: 'rgba(255,255,255,0.5)', lineHeight: 1.4 }}>{c.notes}</div>}
    </div>
  )
}

function Chip({
  label, active, onClick,
}: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? 'var(--sr-cream, #f5e9d4)' : 'rgba(255,255,255,0.14)',
        color:      active ? '#0a1f2a' : 'rgba(255,255,255,0.85)',
        border:     'none',
        borderRadius: 999,
        padding: '7px 14px',
        margin:  '0 -4px',
        fontFamily:    'var(--font-mono)',
        fontSize:      10.5,
        letterSpacing: '0.1em',
        fontWeight:    500,
        cursor:        'pointer',
        whiteSpace:    'nowrap',
        transition:    'background 200ms, color 200ms',
      }}
    >
      {label}
    </button>
  )
}

function Spacer() {
  return <span style={{ width: 16, height: 1, background: 'transparent', flexShrink: 0 }} />
}
