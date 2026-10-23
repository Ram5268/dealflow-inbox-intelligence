'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import ChatSurfaceShell from '@/components/ChatSurfaceShell'
import GooeyFilter from '@/components/GooeyFilter'
import DismissReasonSheet from '@/components/DismissReasonSheet'
import CalendarConfirmSheet from '@/components/CalendarConfirmSheet'
import DraftOutreachSheet from '@/components/DraftOutreachSheet'
import PartyCard from '@/components/PartyCard'
import { showToast as showErrorToast } from '@/components/Toast'
import { formatPriceRange, timeAgo } from '@/lib/utils'
import { DEFAULT_MATCH_TAB, MATCH_TABS, countsOf, emptyState, matchesQuery, mergePage, sumCounts, type MatchTab } from '@/lib/matching/matchesList'

function MatchCardSkeleton() {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.04)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 14,
      padding: 14,
      marginBottom: 10,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      <div style={{
        height: 12, width: '40%', borderRadius: 4,
        background: 'linear-gradient(100deg, rgba(255,255,255,0.04) 30%, rgba(255,255,255,0.1) 50%, rgba(255,255,255,0.04) 70%)',
        backgroundSize: '200% 100%',
        animation: 'sr-shimmer 1.4s linear infinite',
      }} />
      <div style={{
        height: 18, width: '75%', borderRadius: 4,
        background: 'linear-gradient(100deg, rgba(255,255,255,0.04) 30%, rgba(255,255,255,0.1) 50%, rgba(255,255,255,0.04) 70%)',
        backgroundSize: '200% 100%',
        animation: 'sr-shimmer 1.4s linear infinite',
      }} />
      <div style={{
        height: 12, width: '60%', borderRadius: 4,
        background: 'linear-gradient(100deg, rgba(255,255,255,0.04) 30%, rgba(255,255,255,0.1) 50%, rgba(255,255,255,0.04) 70%)',
        backgroundSize: '200% 100%',
        animation: 'sr-shimmer 1.4s linear infinite',
      }} />
    </div>
  )
}

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
  // Brief 35: contact supply (a CRM seller) carries its seller-side fields.
  opportunityType?: string
  mojoList?: string | null
  phone?: string | null
  crmUrl?: string | null
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
  intent: string | null
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
  tier: 'HOT' | 'WARM' | 'POSSIBLE' | null       // Brief 7.1 — from the matching engine
  partyPriority: 'SE' | 'NORMAL' | null           // Brief 7.1 — SE = StreetEasy Expert
  counterpartType: string
  seen: boolean
  createdAt: string
  primary: PrimaryOpp | null
  counterpart: CounterpartOpp | CounterpartMojo | null
}

interface MatchesResponse {
  matches: Match[]
  counts: { total: number; unseen: number; mojo: number; listings: number; showings: number }
  nextCursor?: string | null // Brief 48 (PR 12): where the next page starts; null on the last page
}

// Brief 7.4 (Section B) — party grouping
type PartyRole = 'all' | 'buyer' | 'renter' | 'seller'
interface Party {
  id: string
  name: string
  role: 'BUYER' | 'RENTER' | 'SELLER'
  source: 'inbox' | 'mojo'
  isSEExpert: boolean
  criteria: string
  matchCount: number
  tierBreakdown: { hot: number; warm: number; possible: number }
  topMatchId: string
}
interface PartiesResponse {
  parties: Party[]
  counts: { total: number; buyers: number; renters: number; sellers: number }
}

// Brief 48 (PR 12, item 4.4): the tabs come from lib/matching/matchesList.ts:
// HOT 80+, WARM 65 to 79, ALL, each one tier (the stored tier, else the score;
// lib/matching/tiers.ts), with HOT first and the default. They used to start at
// 90 and 70, which matched no tier.
type ScoreBand = MatchTab

// Brief 7.1 — qualitative tier chip. Null (legacy sync-path rows) renders nothing.
function tierChip(tier: Match['tier']): { text: string; tone: string } | null {
  switch (tier) {
    case 'HOT':      return { text: '🔴 HOT',      tone: '#EF4444' }
    case 'WARM':     return { text: '🟡 WARM',     tone: '#F59E0B' }
    case 'POSSIBLE': return { text: '⚪ POSSIBLE', tone: '#94A3B8' }
    default:         return null
  }
}

function typeBadge(m: Match): { text: string; tone: string } {
  if (m.primary?.opportunityType === 'contact')     return { text: 'SELLER ↔ BUYER',   tone: 'rgba(230,140,80,0.95)' }
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
  // Brief 41 (H7): a homeowner has no asking price (our estimate is never shown as one).
  const pPrice = p.opportunityType === 'contact' ? 'off-market' : formatPriceRange(p.minPrice, p.maxPrice, p.price)
  const pBit = `${pPrice}${p.beds ? ` ${p.beds}BR` : ''}${p.neighborhood ? ` ${p.neighborhood}` : ''}`.trim()
  if (!c) return pBit
  if (m.counterpartType === 'mojo') {
    const mc = c as CounterpartMojo
    return `${pBit} ↔ ${mc.address ?? mc.city ?? 'Mojo lead'}`
  }
  const oc = c as CounterpartOpp
  const cBit = `${formatPriceRange(oc.minPrice, oc.maxPrice, oc.price)}${oc.beds ? ` ${oc.beds}BR` : ''}${oc.neighborhood ? ` ${oc.neighborhood}` : ''}`.trim()
  return `${pBit} ↔ ${cBit}`
}

// Brief 38 — once the pinned match closes, drop ?m= so a refresh shows the plain list.
function dropDeepLink() {
  const url = new URL(window.location.href)
  if (!url.searchParams.has('m')) return
  url.searchParams.delete('m')
  window.history.replaceState(null, '', url.pathname + url.search)
}

export default function MatchesPage() {
  const router = useRouter()
  const [data, setData] = useState<MatchesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [scoreBand, setScoreBand] = useState<ScoreBand>(DEFAULT_MATCH_TAB)
  const [unseenOnly, setUnseenOnly] = useState<boolean>(true)
  // Brief 7.1 — dismiss flow: which match's reason sheet is open, which card is
  // animating out, and the undo toast holding the last-dismissed match + its slot.
  const [dismissSheetFor, setDismissSheetFor] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [toast, setToast] = useState<{ match: Match; index: number } | null>(null)
  const toastTimer = useRef<number | null>(null)
  // Brief 7.3 — action sheets. Calendar confirm, a channel chooser, and the draft
  // sheet (email|text). `notice` is a plain message toast (no undo), reused for
  // "Added to calendar" / "Copied".
  const [calendarFor, setCalendarFor] = useState<Match | null>(null)
  // Outlook is paused (Brief 41): the Calendar button only shows when the server
  // says Outlook features are on. Hidden until then.
  const [graphOn, setGraphOn] = useState(false)
  useEffect(() => {
    fetch('/api/microsoft/status').then(r => r.json()).then(d => setGraphOn(d?.enabled === true)).catch(() => {})
  }, [])
  const [chooserFor, setChooserFor] = useState<Match | null>(null)
  const [draftFor, setDraftFor] = useState<{ match: Match; channel: 'email' | 'text' } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<number | null>(null)
  // Brief 7.4 (Section B) — Matches | Parties view toggle (persisted), the party
  // role filter, party data, and which party card is expanded.
  const [viewMode, setViewMode] = useState<'matches' | 'parties'>('matches')
  const [partyRole, setPartyRole] = useState<PartyRole>('all')
  const [parties, setParties] = useState<PartiesResponse | null>(null)
  const [partiesLoading, setPartiesLoading] = useState(false)
  const [partiesError, setPartiesError] = useState<string | null>(null)
  const [expandedPartyId, setExpandedPartyId] = useState<string | null>(null)
  // Brief 38 — the ?m=<id> match, fetched by id and pinned above the list.
  const [pinned, setPinned] = useState<Match | null>(null)
  const [pinLoading, setPinLoading] = useState(false)
  // Brief 48 (PR 12): paging past the first 200. nextCursor is where the next page
  // starts (null: no more); listSeq drops a reply that belongs to an older tab.
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const listSeq = useRef(0)

  // Restore persisted view once on mount. A ?m=<id> deep-link (a push
  // notification tap, or "Open" in the CRM) forces the Matches view and pins that
  // match at the top, expanded, whatever the tab, the unseen filter or the cap.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const deepLink = new URLSearchParams(window.location.search).get('m')
    if (deepLink) {
      setViewMode('matches')
      setExpandedId(deepLink)
      setPinLoading(true)
      fetch(`/api/matches?id=${encodeURIComponent(deepLink)}`)
        .then(async r => {
          const m = r.ok ? (await r.json() as MatchesResponse).matches[0] : undefined
          if (!m) throw new Error(`match ${r.status}`)
          setPinned(m)
        })
        .catch(() => { dropDeepLink(); showErrorToast("Couldn't open that match") })
        .finally(() => setPinLoading(false))
      return
    }
    const v = window.localStorage.getItem('matchesViewMode')
    if (v === 'parties' || v === 'matches') setViewMode(v)
  }, [])
  useEffect(() => {
    if (typeof window !== 'undefined') window.localStorage.setItem('matchesViewMode', viewMode)
  }, [viewMode])

  function showNotice(message: string) {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    setNotice(message)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3000)
  }

  function bandParams(): URLSearchParams {
    return new URLSearchParams(matchesQuery({ tab: scoreBand, unseenOnly }))
  }

  async function fetchMatches() {
    const seq = ++listSeq.current
    setLoading(true)
    setLoadingMore(false) // a "show more" for the old tab is dropped (listSeq)
    setNextCursor(null)
    try {
      const r = await fetch(`/api/matches?${bandParams().toString()}`)
      if (!r.ok) throw new Error(`matches ${r.status}`)
      const j = await r.json() as MatchesResponse
      if (seq !== listSeq.current) return
      setData(j)
      setNextCursor(j.nextCursor ?? null)
    } catch {
      if (seq === listSeq.current) showErrorToast("Couldn't load matches")
    } finally {
      if (seq === listSeq.current) setLoading(false)
    }
  }

  // Brief 48 (PR 12): the next 200, added below the ones on screen.
  async function fetchMoreMatches() {
    if (!nextCursor || loadingMore) return
    const seq = listSeq.current
    setLoadingMore(true)
    try {
      const r = await fetch(`/api/matches?${matchesQuery({ tab: scoreBand, unseenOnly, cursor: nextCursor })}`)
      if (!r.ok) throw new Error(`matches ${r.status}`)
      const j = await r.json() as MatchesResponse
      if (seq !== listSeq.current) return
      // Counts only the cards this page adds (a card shown already isn't counted twice).
      setData(d => {
        if (!d) return j
        const matches = mergePage(d.matches, j.matches)
        return { ...d, matches, counts: sumCounts(d.counts, countsOf(matches.slice(d.matches.length))) }
      })
      setNextCursor(j.nextCursor ?? null)
    } catch {
      if (seq === listSeq.current) showErrorToast("Couldn't load more matches")
    } finally {
      if (seq === listSeq.current) setLoadingMore(false)
    }
  }

  async function fetchParties() {
    setPartiesLoading(true)
    try {
      const params = bandParams()
      if (partyRole !== 'all') params.set('role', partyRole)
      const r = await fetch(`/api/matches/parties?${params.toString()}`)
      if (!r.ok) throw new Error(`parties ${r.status}`)
      setParties(await r.json() as PartiesResponse)
      setPartiesError(null)
    } catch {
      setParties(null) // never leave the previous tab's parties on screen
      setPartiesError("Couldn't load parties. Try again.")
      showErrorToast("Couldn't load parties")
    } finally {
      setPartiesLoading(false)
    }
  }

  // Closing the pinned match returns to the normal list.
  function unpin() {
    setPinned(null)
    dropDeepLink()
  }

  // Matches load for both views (party expansion reuses the loaded match cards).
  useEffect(() => { void fetchMatches() }, [scoreBand, unseenOnly])
  useEffect(() => { if (viewMode === 'parties') void fetchParties() }, [viewMode, partyRole, scoreBand, unseenOnly])

  function toggleExpand(m: Match) {
    if (expandedId === m.id) {
      setExpandedId(null)
      if (pinned?.id === m.id) unpin()
      return
    }
    setExpandedId(m.id)
    if (!m.seen) {
      void fetch('/api/matches', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id: m.id }),
      })
      setPinned(p => p?.id === m.id ? { ...p, seen: true } : p)
      setData(d => d ? {
        ...d,
        matches: d.matches.map(x => x.id === m.id ? { ...x, seen: true } : x),
        counts:  { ...d.counts, unseen: Math.max(0, d.counts.unseen - 1) },
      } : d)
    }
  }

  // Sheet already POSTed the dismissal. Animate the card out (200ms), then drop
  // it from the list and raise the undo toast (holding the match + its old slot).
  function handleDismissed(matchId: string) {
    setDismissSheetFor(null)
    const idx = data?.matches.findIndex(x => x.id === matchId) ?? -1
    const match = idx >= 0 ? data!.matches[idx] : pinned?.id === matchId ? pinned : null
    setRemovingId(matchId)
    window.setTimeout(() => {
      if (pinned?.id === matchId) unpin()
      setData(d => {
        if (!d || !d.matches.some(x => x.id === matchId)) return d
        const removed = d.matches.find(x => x.id === matchId)
        return {
          ...d,
          matches: d.matches.filter(x => x.id !== matchId),
          counts: {
            ...d.counts,
            total:  Math.max(0, d.counts.total - 1),
            unseen: removed && !removed.seen ? Math.max(0, d.counts.unseen - 1) : d.counts.unseen,
          },
        }
      })
      setRemovingId(null)
      if (match) showToast(match, Math.max(idx, 0))
    }, 200)
  }

  function showToast(match: Match, index: number) {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    setToast({ match, index })
    toastTimer.current = window.setTimeout(() => setToast(null), 5000)
  }

  async function undoDismiss() {
    if (!toast) return
    const { match, index } = toast
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    setToast(null)
    setData(d => {
      if (!d) return d
      if (d.matches.some(x => x.id === match.id)) return d
      const next = [...d.matches]
      next.splice(Math.min(index, next.length), 0, match)
      return {
        ...d,
        matches: next,
        counts: {
          ...d.counts,
          total:  d.counts.total + 1,
          unseen: match.seen ? d.counts.unseen : d.counts.unseen + 1,
        },
      }
    })
    try { await fetch(`/api/matches/${match.id}/dismiss`, { method: 'DELETE' }) }
    catch (e) {
      console.warn('[matches] undo failed', e)
      showErrorToast("Undo failed — refresh to retry")
    }
  }

  // Brief 7.4 — single match-card renderer, shared by the Matches list and the
  // Parties view's inline expansion (so party cards reuse the exact same card).
  function renderMatchCard(m: Match) {
    const badge       = typeBadge(m)
    const tc          = tierChip(m.tier)
    const isExpanded  = expandedId === m.id
    const isRemoving  = removingId === m.id
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
          opacity: isRemoving ? 0 : (m.seen ? 0.55 : 1),
          transform: isRemoving ? 'scale(0.96)' : 'scale(1)',
          transition: 'opacity 200ms, transform 200ms',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.12em' }}>
          <span>
            {tc && <span style={{ color: tc.tone }}>{tc.text} · </span>}
            <span style={{ color: badge.tone }}>{badge.text} · SCORE {m.score}</span>
          </span>
          <span style={{ color: 'rgba(255,255,255,0.4)' }}>{isExpanded ? '▾' : '→'}</span>
        </div>
        <div style={{ marginTop: 6, fontSize: 14, color: '#fff', fontWeight: 500, lineHeight: 1.35 }}>
          {primaryStr}{counterStr ? <span style={{ color: 'rgba(255,255,255,0.55)', fontWeight: 400 }}>{' ↔ '}{counterStr}</span> : null}
        </div>
        {ctxStr && (
          <div style={{ marginTop: 3, fontSize: 12, color: 'rgba(255,255,255,0.5)', lineHeight: 1.4 }}>{ctxStr}</div>
        )}
        {m.partyPriority === 'SE' && (
          <div style={{ marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'var(--sr-cream, #EAB308)' }}>
            ⭐ SE EXPERT
          </div>
        )}
        {isExpanded && (
          <ExpandedDetail
            m={m}
            router={router}
            onDismiss={e => { e.stopPropagation(); setDismissSheetFor(m.id) }}
            onCalendar={graphOn ? e => { e.stopPropagation(); setCalendarFor(m) } : undefined}
            onDraft={e => { e.stopPropagation(); setChooserFor(m) }}
          />
        )}
      </div>
    )
  }

  // Matches involving a given party (either side), for inline party expansion.
  function matchesForParty(partyId: string): Match[] {
    if (!data) return []
    return data.matches.filter(m =>
      m.counterpart && ('id' in m.counterpart) && (m.counterpart as { id: string }).id === partyId
      || (m.primary?.id === partyId),
    )
  }

  return (
    <ChatSurfaceShell>
      <GooeyFilter id="goo-filter" strength={9} />

      {/* Brief 7.4 — Matches | Parties view toggle */}
      <ViewToggle mode={viewMode} onChange={setViewMode} />

      <TabBar
        active={scoreBand}
        onChange={setScoreBand}
        rightAction={
          <button
            onClick={() => setUnseenOnly(v => !v)}
            style={{
              position: 'relative',
              fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.12em',
              color: 'rgba(255,255,255,0.5)', background: 'transparent', border: 'none',
              padding: '4px 8px', cursor: 'pointer',
            }}
          >
            {/* Brief 20.0 — transparent hit-slop grows the tap target to ≥44px
                tall without changing the toggle's size or position (polish, not rework). */}
            <span aria-hidden style={{ position: 'absolute', inset: '-12px 0' }} />
            {unseenOnly ? 'SHOW SEEN' : 'HIDE SEEN'}
          </button>
        }
      />

      {viewMode === 'parties' && (
        <PartyChips role={partyRole} counts={parties?.counts} onChange={setPartyRole} />
      )}

      <div style={{
        flex: 1, overflowY: 'auto', scrollbarWidth: 'none',
        // Brief 22.0 — contain overscroll + add safe-area clearance so the last
        // card clears the iOS home indicator (no composer here, just the inset).
        overscrollBehavior: 'contain',
        padding: '14px 16px calc(80px + env(safe-area-inset-bottom))',
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        {viewMode === 'matches' ? (
          <>
            {pinned ? (
              <>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.14em', color: 'rgba(255,255,255,0.35)' }}>
                  OPENED FROM A LINK
                </div>
                {renderMatchCard(pinned)}
              </>
            ) : pinLoading && <MatchCardSkeleton />}
            {data && (
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.14em',
                color: 'rgba(255,255,255,0.35)', marginBottom: 4,
              }}>
                {`${data.counts.unseen} UNSEEN · ${data.counts.mojo} MOJO · ${data.counts.listings} LISTINGS · ${data.counts.showings} SHOWINGS`}
              </div>
            )}
            {loading ? (
              <div style={{ marginTop: 12 }}>
                <MatchCardSkeleton />
                <MatchCardSkeleton />
                <MatchCardSkeleton />
              </div>
            ) : !data || (data.matches.length === 0 && !nextCursor) ? (
              <EmptyState {...emptyState('matches', scoreBand, unseenOnly)} />
            ) : (
              <>
                {data.matches.filter(m => m.id !== pinned?.id).map(m => renderMatchCard(m))}
                {nextCursor && <ShowMoreButton loading={loadingMore} onClick={() => void fetchMoreMatches()} />}
              </>
            )}
          </>
        ) : (
          partiesLoading ? (
            <div style={{ marginTop: 12 }}>
              <MatchCardSkeleton />
              <MatchCardSkeleton />
              <MatchCardSkeleton />
            </div>
          ) : partiesError ? (
            <div style={{ marginTop: 40, textAlign: 'center', fontFamily: 'var(--font-ui)', fontSize: 14, color: 'rgba(255,150,150,0.8)' }}>{partiesError}</div>
          ) : !parties || parties.parties.length === 0 ? (
            <EmptyState {...emptyState('parties', scoreBand, unseenOnly)} />
          ) : (
            parties.parties.map(p => (
              <PartyCard
                key={p.id}
                party={p}
                expanded={expandedPartyId === p.id}
                onToggle={() => setExpandedPartyId(id => id === p.id ? null : p.id)}
              >
                {matchesForParty(p.id).map(m => renderMatchCard(m))}
              </PartyCard>
            ))
          )
        )}
      </div>

      {dismissSheetFor && (
        <DismissReasonSheet
          matchId={dismissSheetFor}
          open={!!dismissSheetFor}
          onClose={() => setDismissSheetFor(null)}
          onDismissed={handleDismissed}
        />
      )}

      {calendarFor && (
        <CalendarConfirmSheet
          matchId={calendarFor.id}
          address={primaryLabel(calendarFor.primary)}
          partyName={counterpartLabel(calendarFor)}
          open={!!calendarFor}
          onClose={() => setCalendarFor(null)}
          onScheduled={msg => { setCalendarFor(null); showNotice(msg) }}
        />
      )}

      {chooserFor && (
        <ChannelChooserSheet
          partyName={counterpartLabel(chooserFor)}
          open={!!chooserFor}
          onClose={() => setChooserFor(null)}
          onPick={channel => { setDraftFor({ match: chooserFor, channel }); setChooserFor(null) }}
        />
      )}

      {draftFor && (
        <DraftOutreachSheet
          matchId={draftFor.match.id}
          partyName={counterpartLabel(draftFor.match)}
          channel={draftFor.channel}
          open={!!draftFor}
          onClose={() => setDraftFor(null)}
          onToast={showNotice}
        />
      )}

      {notice && (
        <div style={{
          position: 'fixed', left: '50%', bottom: 96, transform: 'translateX(-50%)',
          zIndex: 210, width: '100%', maxWidth: 512, padding: '0 16px',
          display: 'flex', justifyContent: 'center', pointerEvents: 'none',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: 'rgba(20,24,30,0.82)', border: '1px solid rgba(255,255,255,0.14)',
            backdropFilter: 'blur(20px) saturate(160%)', WebkitBackdropFilter: 'blur(20px) saturate(160%)',
            borderRadius: 999, padding: '10px 18px', boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          }}>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'rgba(255,255,255,0.85)' }}>{notice}</span>
          </div>
        </div>
      )}

      {toast && (
        <div style={{
          position: 'fixed', left: '50%', bottom: 96, transform: 'translateX(-50%)',
          zIndex: 120, width: '100%', maxWidth: 512, padding: '0 16px',
          display: 'flex', justifyContent: 'center', pointerEvents: 'none',
        }}>
          <div style={{
            pointerEvents: 'auto',
            display: 'flex', alignItems: 'center', gap: 14,
            background: 'rgba(20,24,30,0.82)',
            border: '1px solid rgba(255,255,255,0.14)',
            backdropFilter: 'blur(20px) saturate(160%)',
            WebkitBackdropFilter: 'blur(20px) saturate(160%)',
            borderRadius: 999, padding: '10px 16px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          }}>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'rgba(255,255,255,0.8)' }}>Match dismissed</span>
            <button
              onClick={undoDismiss}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
                fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.12em',
                color: 'var(--sr-cream, #EAB308)', textTransform: 'uppercase',
              }}
            >
              Undo
            </button>
          </div>
        </div>
      )}

      <style>{`@keyframes sr-shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }`}</style>
    </ChatSurfaceShell>
  )
}

// Brief 48 (PR 12): the empty list's words (lib/matching/matchesList.ts emptyState).
function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 40, textAlign: 'center', padding: '0 8px' }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, color: 'rgba(255,255,255,0.6)', fontWeight: 300 }}>{title}</div>
      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'rgba(255,255,255,0.3)', lineHeight: 1.45 }}>{hint}</div>
    </div>
  )
}

// Brief 48 (PR 12): below the last card while there are more matches in the tab.
function ShowMoreButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      style={{
        alignSelf: 'center', marginTop: 4, minHeight: 44, padding: '10px 22px', borderRadius: 999,
        background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)',
        fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.12em',
        color: loading ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.75)', cursor: loading ? 'default' : 'pointer',
      }}
    >
      {loading ? 'LOADING…' : 'SHOW MORE MATCHES'}
    </button>
  )
}

// ── TabBar: 3 quality-tier tabs with a morphing gooey active-tab indicator ──
function TabBar({
  active, onChange, rightAction,
}: {
  active: ScoreBand
  onChange: (id: ScoreBand) => void
  rightAction?: React.ReactNode
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Record<ScoreBand, HTMLButtonElement | null>>({ hot: null, warm: null, all: null })
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null)

  useEffect(() => {
    function measure() {
      const wrap = wrapRef.current
      const el = tabRefs.current[active]
      if (!wrap || !el) return
      const wrapRect = wrap.getBoundingClientRect()
      const elRect = el.getBoundingClientRect()
      setIndicator({ left: elRect.left - wrapRect.left, width: elRect.width })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [active])

  return (
    <div style={{ padding: '0 16px', position: 'relative' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'relative' }}>
        <div ref={wrapRef} style={{ position: 'relative', display: 'flex' }}>
          {indicator && (
            <div
              aria-hidden
              style={{
                position: 'absolute',
                top: 0, bottom: -2,
                left: indicator.left, width: indicator.width,
                filter: 'url(#goo-filter)',
                transition: 'left 280ms cubic-bezier(.4,1.2,.6,1), width 280ms cubic-bezier(.4,1.2,.6,1)',
                pointerEvents: 'none',
              }}
            >
              {/* Main pill — sits behind active tab label */}
              <div style={{
                position: 'absolute', inset: '4px 0 8px',
                background: 'var(--sr-cream, #f5e9d4)',
                borderRadius: 14,
              }} />
              {/* Connecting tongue — bleeds into the content panel for the folder effect */}
              <div style={{
                position: 'absolute',
                left: '50%', bottom: 0,
                transform: 'translateX(-50%)',
                width: '70%', height: 14,
                background: 'var(--sr-cream, #f5e9d4)',
                borderRadius: 8,
              }} />
            </div>
          )}

          {MATCH_TABS.map(t => {
            const isActive = active === t.id
            return (
              <button
                key={t.id}
                ref={el => { tabRefs.current[t.id] = el }}
                onClick={() => onChange(t.id)}
                style={{
                  position: 'relative',
                  zIndex: 1,
                  background: 'transparent',
                  border: 'none',
                  padding: '12px 18px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  letterSpacing: '0.12em',
                  fontWeight: 500,
                  color: isActive ? '#0a1f2a' : 'rgba(255,255,255,0.5)',
                  cursor: 'pointer',
                  transition: 'color 220ms',
                  whiteSpace: 'nowrap',
                }}
              >
                {t.label}
              </button>
            )
          })}
        </div>

        {rightAction && (
          <div style={{ position: 'relative', zIndex: 1 }}>{rightAction}</div>
        )}
      </div>
    </div>
  )
}

function ExpandedDetail({ m, router, onDismiss, onCalendar, onDraft }: {
  m: Match
  router: ReturnType<typeof useRouter>
  onDismiss: (e: React.MouseEvent) => void
  onCalendar?: (e: React.MouseEvent) => void // absent while Outlook is paused
  onDraft: (e: React.MouseEvent) => void
}) {
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

      {m.primary?.opportunityType === 'contact' ? (
        <SellerSide p={m.primary} />
      ) : m.primary && (
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

      {/* Brief 7.3 — action row. All three live now: Dismiss (reason sheet),
          Calendar (confirm sheet → Graph POST /me/events), Draft (channel chooser
          → Sonnet-drafted email/text, native-app handoff). Draft consolidates
          email+text behind a chooser so the row stays 3 wide. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <ActionPill label="✓ Dismiss"   onClick={onDismiss} />
        {onCalendar && <ActionPill label="📅 Calendar" onClick={onCalendar} />}
        <ActionPill label="✍️ Draft"    onClick={onDraft} />
      </div>
    </div>
  )
}

// Brief 7.3 — tiny bottom sheet that picks the outreach channel before drafting,
// so the action row stays 3 buttons wide. Same glass styling as the other sheets.
function ChannelChooserSheet({ partyName, open, onClose, onPick }: {
  partyName: string
  open: boolean
  onClose: () => void
  onPick: (channel: 'email' | 'text') => void
}) {
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(raf)
  }, [open])
  if (!open) return null

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', justifyContent: 'center', alignItems: 'flex-end' }}>
      <div aria-hidden style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)', opacity: entered ? 1 : 0, transition: 'opacity 200ms ease' }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Choose draft channel"
        onClick={e => e.stopPropagation()}
        style={{
          position: 'relative', width: '100%', maxWidth: 512,
          background: 'rgba(20,24,30,0.72)',
          backdropFilter: 'blur(28px) saturate(160%)', WebkitBackdropFilter: 'blur(28px) saturate(160%)',
          borderTop: '1px solid rgba(255,255,255,0.12)',
          borderTopLeftRadius: 22, borderTopRightRadius: 22,
          boxShadow: '0 -12px 40px rgba(0,0,0,0.4)',
          padding: '10px 18px calc(24px + env(safe-area-inset-bottom))',
          transform: entered ? 'translateY(0)' : 'translateY(100%)',
          transition: 'transform 300ms cubic-bezier(0.4, 0.2, 0.2, 1)',
          display: 'flex', flexDirection: 'column', gap: 12,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: 2 }}>
          <div style={{ width: 36, height: 4, borderRadius: 999, background: 'rgba(255,255,255,0.3)' }} />
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.14em', color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase' }}>
          Draft to {partyName}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {([['email', '📧 Email'], ['text', '📱 Text']] as const).map(([ch, label]) => (
            <button
              key={ch}
              onClick={() => onPick(ch)}
              style={{
                flex: 1, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 14, padding: '16px 0', fontFamily: 'var(--font-ui)', fontSize: 15,
                color: 'rgba(255,255,255,0.85)', cursor: 'pointer',
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={onClose}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// Brief 7.4 — Matches | Parties segmented control above the score-band tabs.
function ViewToggle({ mode, onChange }: { mode: 'matches' | 'parties'; onChange: (m: 'matches' | 'parties') => void }) {
  return (
    <div style={{ padding: '4px 16px 6px', display: 'flex', justifyContent: 'center' }}>
      <div style={{ display: 'inline-flex', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 999, padding: 3 }}>
        {(['matches', 'parties'] as const).map(m => {
          const active = mode === m
          return (
            <button
              key={m}
              onClick={() => onChange(m)}
              style={{
                background: active ? 'var(--sr-cream, #f5e9d4)' : 'transparent',
                color: active ? '#0a1f2a' : 'rgba(255,255,255,0.6)',
                border: 'none', borderRadius: 999, padding: '6px 18px', cursor: 'pointer',
                fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.12em', fontWeight: active ? 600 : 400,
                textTransform: 'uppercase', transition: 'background 160ms, color 160ms',
              }}
            >
              {m === 'matches' ? 'Matches' : 'Parties'}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// Brief 7.4 — role filter chips shown only in Parties view, with live counts.
function PartyChips({ role, counts, onChange }: {
  role: PartyRole
  counts: PartiesResponse['counts'] | undefined
  onChange: (r: PartyRole) => void
}) {
  const chips: Array<{ id: PartyRole; label: string; n?: number }> = [
    { id: 'all',    label: 'All',     n: counts?.total },
    { id: 'buyer',  label: 'Buyers',  n: counts?.buyers },
    { id: 'renter', label: 'Renters', n: counts?.renters },
    { id: 'seller', label: 'Sellers', n: counts?.sellers },
  ]
  return (
    <div style={{ display: 'flex', gap: 8, padding: '2px 16px 0', flexWrap: 'wrap' }}>
      {chips.map(c => {
        const active = role === c.id
        return (
          <button
            key={c.id}
            onClick={() => onChange(c.id)}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 2px',
              fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase',
              color: active ? 'var(--sr-cream, #EAB308)' : 'rgba(255,255,255,0.45)',
              borderBottom: active ? '1px solid var(--sr-cream, #EAB308)' : '1px solid transparent',
            }}
          >
            {c.label}{typeof c.n === 'number' ? ` (${c.n})` : ''}
          </button>
        )
      })}
    </div>
  )
}

function ActionPill({ label, onClick }: { label: string; onClick: (e: React.MouseEvent) => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.12)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderRadius: 999,
        padding: '8px 14px',
        fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 400,
        color: hover ? 'var(--sr-cream, #EAB308)' : 'rgba(255,255,255,0.75)',
        cursor: 'pointer',
        transition: 'color 160ms',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
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

// Brief 35: contact supply is a CRM seller, so link to the CRM lead, not
// /opportunities. The phone is shown as text only; dialing happens in the CRM.
function SellerSide({ p }: { p: PrimaryOpp }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: '10px 12px' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.14em', color: 'rgba(255,255,255,0.45)' }}>SELLER</div>
      {/* Brief 41 (H7): the title is the address (or "Homeowner in …"), never the
          homeowner's name; the name is in the CRM (Open in CRM). */}
      <div style={{ marginTop: 4, fontSize: 13, color: '#fff', fontWeight: 500 }}>{p.extractedTitle}</div>
      {p.address && p.address !== p.extractedTitle && <div style={{ marginTop: 2, fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>{p.address}</div>}
      <div style={{ marginTop: 4, fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>
        {[p.neighborhood, p.units ? `${p.units}-unit` : null, p.beds ? `${p.beds} beds` : null, p.mojoList].filter(Boolean).join(' · ')}
      </div>
      {p.phone && <div style={{ marginTop: 4, fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>📞 {p.phone}</div>}
      {p.crmUrl && (
        <a href={p.crmUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
          style={{ display: 'inline-block', marginTop: 8, fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: '0.1em', color: 'var(--sr-cream)' }}>
          Open in CRM →
        </a>
      )}
    </div>
  )
}

function MojoSide({ c }: { c: CounterpartMojo }) {
  const label = c.intent === 'BUYER' ? '🔥 MOJO BUYER' : c.intent === 'RENTER' ? '🔥 MOJO RENTER' : '🔥 MOJO SELLER LEAD'
  return (
    <div style={{ background: 'rgba(230,140,80,0.08)', borderRadius: 12, padding: '10px 12px', border: '1px solid rgba(230,140,80,0.18)' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.14em', color: 'rgba(230,140,80,0.95)' }}>{label}</div>
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
