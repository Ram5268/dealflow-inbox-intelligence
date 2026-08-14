'use client'

import { useState, useEffect, useRef, useReducer, useCallback, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { ExtractedOpportunity } from '@prisma/client'
import { useRouter } from 'next/navigation'
import ChatSurfaceShell from '@/components/ChatSurfaceShell'
import MatchArc from '@/components/MatchArc'
import ChatShaderBg from '@/components/ChatShaderBg'
import MicButton from '@/components/MicButton'
import VoiceConversation from '@/components/VoiceConversation'
import { BlurFade } from '@/components/BlurFade'
import { CATEGORY_LABELS, formatPriceRange } from '@/lib/utils'

// ─── Brief 2.5 — Drift interaction logging ────────────────
// Fire-and-forget POST to /api/chat/interaction. Never awaited, never surfaces
// errors to the user — instrumentation must not degrade the chat experience.
function postInteraction(body: {
  interactionId: string
  event: 'click' | 'feedback'
  cardId?: string
  cardKind?: string
  rank?: number
  vote?: 'helpful' | 'wrong_result' | 'missing_result'
  note?: string
}) {
  fetch('/api/chat/interaction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {})
}

// Small "👎 Something wrong?" affordance shown below each in-session Drift reply.
function FeedbackRow({ interactionId }: { interactionId: string }) {
  const [submitted, setSubmitted] = useState(false)
  const opts: { label: string; vote: 'wrong_result' | 'missing_result' | 'helpful' }[] = [
    { label: 'Wrong results', vote: 'wrong_result' },
    { label: 'Missing a listing I know exists', vote: 'missing_result' },
    { label: 'Helpful, no changes', vote: 'helpful' },
  ]
  if (submitted) {
    return (
      <div style={{ marginTop: 8, marginLeft: 4, fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.12em', color: 'rgba(255,255,255,0.4)' }}>
        THANKS — LOGGED
      </div>
    )
  }
  return (
    <div style={{ marginTop: 8, marginLeft: 4 }}>
      <div aria-label="Something wrong with this reply" style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.12em', color: 'rgba(255,255,255,0.35)', marginBottom: 5 }}>
        👎 SOMETHING WRONG?
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {opts.map(o => (
          <button
            key={o.vote}
            onClick={() => { postInteraction({ interactionId, event: 'feedback', vote: o.vote }); setSubmitted(true) }}
            style={{
              position: 'relative',
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.12)',
              color: 'rgba(255,255,255,0.6)', borderRadius: 999,
              padding: '5px 10px',
              fontFamily: 'var(--font-ui)', fontSize: 10.5, fontWeight: 300,
              cursor: 'pointer',
            }}
          >
            {/* Brief 20.0 — transparent hit-slop grows the tap target to ≥44px tall
                without changing the pill's visible size (polish, not rework). */}
            <span aria-hidden style={{ position: 'absolute', inset: '-11px 0' }} />
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Types ────────────────────────────────────────────────

interface SEListing {
  id: string
  url: string
  price: number | null
}

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  deals?: (ExtractedOpportunity & { matchScore?: number; streetEasyUrl?: string | null })[]
  suggestions?: string[]
  seListings?: SEListing[]
  seFilterUrl?: string | null
  interactionId?: string
  createdAt: string
}

type ChatView = 'memory' | 'memory_new' | 'thread' | 'raised'

interface ChatState {
  view: ChatView
  stack: ChatView[]
  focusedMsg: Message | null
  activeDealIdx: number
}

type Action =
  | { type: 'GO'; to: ChatView }
  | { type: 'BACK' }
  | { type: 'OPEN_THREAD'; msg: Message }
  | { type: 'SET_ACTIVE'; idx: number }
  | { type: 'RESET_NEW' }

function reducer(s: ChatState, a: Action): ChatState {
  switch (a.type) {
    case 'GO':        return { ...s, stack: [...s.stack, s.view], view: a.to }
    case 'BACK': {
      const stack = [...s.stack]; const prev = stack.pop() ?? 'memory'
      return { ...s, view: prev, stack }
    }
    case 'OPEN_THREAD':
      return { ...s, stack: [...s.stack, s.view], view: 'raised', focusedMsg: a.msg, activeDealIdx: 0 }
    case 'SET_ACTIVE':
      return { ...s, activeDealIdx: a.idx }
    case 'RESET_NEW':
      return { view: 'memory_new', stack: [], focusedMsg: null, activeDealIdx: 0 }
    default: return s
  }
}

const INITIAL: ChatState = { view: 'memory', stack: [], focusedMsg: null, activeDealIdx: 0 }

// ─── Opacity scale (7 steps, newest = 1.0) ────────────────

function msgOpacity(indexFromEnd: number): number {
  const scale = [1, 0.92, 0.78, 0.62, 0.5, 0.4, 0.35]
  return scale[Math.min(indexFromEnd, scale.length - 1)]
}

function buildOpacityMap(messages: Message[]): Map<string, number> {
  const map = new Map<string, number>()
  let n = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    map.set(messages[i].id, n++)
  }
  return map
}

// ─── Prompt chips ─────────────────────────────────────────

interface Chip { label: string; query: string }

const GREETINGS = [
  'What are we looking at?',
  'What just came in?',
  'Who needs a deal?',
  'What\'s moving today?',
  'Where do we start?',
  'What\'s on your radar?',
  'Any leads worth chasing?',
  'What\'s the ask?',
  'Who\'s looking?',
  'What landed overnight?',
]

function pickGreeting() {
  return GREETINGS[Math.floor(Math.random() * GREETINGS.length)]
}

// ─── Shared atoms ─────────────────────────────────────────

function BackBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 34, height: 34, borderRadius: '50%',
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.14)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 0, cursor: 'pointer', flexShrink: 0,
      }}
      aria-label="Back"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 18l-6-6 6-6" />
      </svg>
    </button>
  )
}

function TimeBreak({ label }: { label: string }) {
  return (
    <div style={{ textAlign: 'center', margin: '6px 0 2px' }}>
      <span style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9, letterSpacing: '0.2em',
        color: 'rgba(255,255,255,0.55)',
      }}>
        {label}
      </span>
    </div>
  )
}

// Brief 7.4 — TTS speaker button. Uses the browser SpeechSynthesis API; no
// network call. Self-gates on voice-enabled + API availability so it silently
// no-ops where unsupported.
function SpeakButton({ text }: { text: string }) {
  const [speaking, setSpeaking] = useState(false)
  const enabled = process.env.NEXT_PUBLIC_VOICE_ENABLED === 'true'
  if (!enabled || typeof window === 'undefined' || !('speechSynthesis' in window) || !text.trim()) return null

  function toggle() {
    const synth = window.speechSynthesis
    if (speaking) { synth.cancel(); setSpeaking(false); return }
    synth.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.onend = () => setSpeaking(false)
    u.onerror = () => setSpeaking(false)
    setSpeaking(true)
    synth.speak(u)
  }

  return (
    <button
      onClick={toggle}
      aria-label={speaking ? 'Stop reading' : 'Read aloud'}
      style={{
        position: 'relative',
        marginTop: 6, marginLeft: 4, background: 'transparent', border: 'none', cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 0',
        fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.1em',
        color: speaking ? 'var(--sr-cream, #EAB308)' : 'rgba(255,255,255,0.4)',
      }}
    >
      {/* Brief 20.0 — transparent hit-slop grows the tap target to ≥44px
          without changing the icon's size or position (polish, not rework). */}
      <span aria-hidden style={{ position: 'absolute', inset: '-14px -6px' }} />
      {speaking ? '⏹ STOP' : '🔊 LISTEN'}
    </button>
  )
}

// ─── Composer pill (matches design) ───────────────────────

function Composer({
  value, onChange, onSubmit, onOpenVoice, isLoading,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: (files?: File[]) => void
  onOpenVoice: () => void  // Brief 13.0 — mic now opens the voice conversation orb
  isLoading: boolean
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const voiceEnabled = process.env.NEXT_PUBLIC_VOICE_ENABLED === 'true'

  function submit() {
    if ((!value.trim() && files.length === 0) || isLoading) return
    onSubmit(files)
    setFiles([])
    if (fileRef.current) fileRef.current.value = ''
  }

  const canSend = value.trim().length > 0 || files.length > 0

  return (
    <div>
      {files.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {files.map((f, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 5,
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8, padding: '3px 8px',
              fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.65)',
            }}>
              <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
              <button onClick={() => setFiles(p => p.filter((_, j) => j !== i))}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.4)', padding: 0, lineHeight: 1 }}>×</button>
            </div>
          ))}
        </div>
      )}

      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.14)',
        borderRadius: 999,
        padding: '8px 8px 8px 16px',
        backdropFilter: 'blur(20px)',
      }}>
        <input
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
          placeholder="Message Drift…"
          style={{
            flex: 1, background: 'transparent', border: 'none', outline: 'none',
            fontFamily: 'var(--font-ui)', fontSize: 16, fontWeight: 300,
            color: '#fff', padding: '4px 0',
          }}
        />

        {/* Brief 13.0 — mic opens the full-screen voice conversation orb */}
        {voiceEnabled && (
          <MicButton onOpenVoice={onOpenVoice} disabled={isLoading} />
        )}

        {/* Attach */}
        <label style={{
          width: 28, height: 28, borderRadius: '50%', background: 'transparent',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', opacity: 0.7,
        }} aria-label="Attach file">
          <input ref={fileRef} type="file" multiple onChange={e => {
            if (e.target.files) setFiles(p => [...p, ...Array.from(e.target.files!)])
          }} style={{ display: 'none' }} />
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round">
            <path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7L14 4.5a3.5 3.5 0 0 1 5 5L10.5 18a2 2 0 0 1-3-3L15 7" />
          </svg>
        </label>

        {/* Send */}
        <button
          onClick={submit}
          disabled={!canSend && !isLoading}
          style={{
            width: 32, height: 32, borderRadius: '50%',
            background: canSend || isLoading ? '#fff' : 'rgba(255,255,255,0.18)',
            border: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: canSend || isLoading ? 'pointer' : 'default',
            padding: 0, transition: 'background 0.15s',
          }}
          aria-label="Send"
        >
          {isLoading ? (
            <svg width="11" height="11" viewBox="0 0 22 22" fill="none">
              <rect x="3"  y="9"  width="2" height="4" rx="1" fill="#0a1f2a" />
              <rect x="7"  y="6"  width="2" height="10" rx="1" fill="#0a1f2a" />
              <rect x="11" y="4"  width="2" height="14" rx="1" fill="#0a1f2a" />
              <rect x="15" y="7"  width="2" height="8"  rx="1" fill="#0a1f2a" />
              <rect x="19" y="9"  width="2" height="4"  rx="1" fill="#0a1f2a" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
              stroke={canSend ? '#0a1f2a' : '#fff'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          )}
        </button>
      </div>

      <div style={{
        fontFamily: 'var(--font-ui)', fontSize: 10.5, fontWeight: 300,
        color: 'rgba(255,255,255,0.4)', textAlign: 'center', marginTop: 6,
        letterSpacing: '0.02em',
      }}>
        type or hold the mic to speak
      </div>
    </div>
  )
}

// ─── Memory view ──────────────────────────────────────────

function MemoryView({
  messages, loading, loadingHistory, fresh,
  chips, greeting, sessionKey, input, setInput, onSend, onOpenThread, onOpenVoice,
  bottomRef,
}: {
  messages: Message[]
  loading: boolean
  loadingHistory: boolean
  fresh: boolean
  chips: Chip[]
  greeting: string
  sessionKey: number
  input: string
  setInput: (v: string) => void
  onSend: (text?: string, files?: File[]) => void
  onOpenThread: (msg: Message) => void
  onOpenVoice: () => void
  bottomRef: React.RefObject<HTMLDivElement | null>
}) {
  const opacityMap = buildOpacityMap(messages)
  const latestAIId = [...messages].reverse().find(m => m.role === 'assistant')?.id

  function userQuestionFor(msg: Message): string {
    const idx = messages.findIndex(m => m.id === msg.id)
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].content
    }
    return ''
  }

  return (
    <>
      {/* TopIcons rendered by ChatSurfaceShell — no back button on main chat view */}

      {/* Scrollable log — outer div scrolls, inner div anchors content to bottom */}
      <div style={{
        flex: 1, overflowY: 'auto', minHeight: 0,
        scrollbarWidth: 'none' as const,
        // Brief 22.0 — contain overscroll so bouncing the message list can't
        // rubber-band the surface behind it.
        overscrollBehavior: 'contain',
      }}>
      <div style={{
        minHeight: '100%', display: 'flex', flexDirection: 'column',
        justifyContent: 'flex-end', padding: '4px 18px 6px',
      }}>
        {loadingHistory ? (
          <div style={{ textAlign: 'center', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'rgba(255,255,255,0.25)', paddingBottom: 20 }}>
            Loading…
          </div>
        ) : fresh || messages.length === 0 ? (
          /* ─── Fresh / empty state ─── */
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: 18, padding: '0 20px', textAlign: 'center',
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18 }}>
              <BlurFade key={sessionKey} duration={0.25} delay={0.02} yOffset={6} blur="6px">
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 300, letterSpacing: '-0.016em', lineHeight: 1.15, color: '#fff' }}>
                  {greeting}
                </div>
              </BlurFade>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
                {chips.map(c => (
                  <span
                    key={c.label}
                    onClick={() => onSend(c.query)}
                    style={{
                      fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 300,
                      letterSpacing: '-0.005em',
                      padding: '7px 13px', borderRadius: 999,
                      background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.14)',
                      color: 'rgba(255,255,255,0.78)', cursor: 'pointer',
                    }}
                  >
                    {c.label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ) : (
          /* ─── Message log ─── */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {messages.map((m, i) => {
              const prevDate = i > 0 ? new Date(messages[i - 1].createdAt).toDateString() : null
              const thisDate = new Date(m.createdAt).toDateString()
              const showBreak = prevDate !== thisDate
              const opIdx = opacityMap.get(m.id) ?? 6
              const opacity = msgOpacity(opIdx)
              const isLatestAI = m.id === latestAIId

              return (
                <div key={m.id}>
                  {showBreak && (
                    <TimeBreak label={
                      new Date(m.createdAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase() +
                      ' · ' + new Date(m.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
                    } />
                  )}

                  {m.role === 'user' ? (
                    /* User bubble — glass, right-aligned */
                    <div style={{ display: 'flex', justifyContent: 'flex-end', opacity }}>
                      <div style={{
                        maxWidth: '80%',
                        background: 'rgba(255,255,255,0.12)',
                        border: '1px solid rgba(255,255,255,0.14)',
                        borderRadius: 18, borderTopRightRadius: 6,
                        padding: '9px 13px',
                        fontFamily: 'var(--font-ui)', fontSize: 13.5, fontWeight: 300,
                        lineHeight: 1.45, color: 'rgba(255,255,255,0.92)',
                        backdropFilter: 'blur(20px)',
                      }}>
                        {m.content}
                      </div>
                    </div>
                  ) : (
                    /* AI reply — transparent, full-width */
                    <div style={{ opacity }}>
                      <div style={{
                        fontFamily: 'var(--font-ui)', fontSize: 13.5, fontWeight: 300,
                        lineHeight: 1.45, color: isLatestAI ? '#fff' : 'rgba(255,255,255,0.92)',
                        padding: '2px 4px',
                      }}>
                        {m.content}
                      </div>

                      {/* Brief 7.4 — optional TTS: read the reply aloud */}
                      <SpeakButton text={m.content} />

                      {/* StreetEasy search button — shown whenever we have a filter URL */}
                      {m.seFilterUrl && (
                        <div style={{ marginTop: 10, marginLeft: 4 }}>
                          <a
                            href={m.seFilterUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 8,
                              padding: '10px 16px', borderRadius: 22,
                              background: 'rgba(255,255,255,0.08)',
                              border: '1px solid rgba(255,255,255,0.18)',
                              textDecoration: 'none',
                            }}
                          >
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 500, color: '#fff', letterSpacing: '0.06em' }}>
                              SEARCH STREETEASY
                            </span>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(120,200,220,0.9)' }}>↗</span>
                          </a>
                        </div>
                      )}

                      {/* Inline action chip — only on latest AI reply that has deals */}
                      {isLatestAI && (m.deals?.length ?? 0) > 0 && (
                        <div style={{ display: 'flex', gap: 8, marginTop: 2, marginLeft: 4 }}>
                          <button
                            onClick={() => onOpenThread(m)}
                            style={{
                              background: 'rgba(255,255,255,0.10)',
                              border: '1px solid rgba(255,255,255,0.18)',
                              color: '#fff', borderRadius: 999,
                              padding: '7px 12px',
                              fontFamily: 'var(--font-ui)', fontSize: 11.5, fontWeight: 300,
                              cursor: 'pointer',
                            }}
                          >
                            Show all {m.deals!.length} →
                          </button>
                        </div>
                      )}

                      {m.interactionId && <FeedbackRow interactionId={m.interactionId} />}

                    </div>
                  )}
                </div>
              )
            })}

            {loading && (
              <div style={{ display: 'flex', gap: 5, paddingLeft: 4, paddingTop: 4 }}>
                {[0, 150, 300].map(d => (
                  <span key={d} style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: 'rgba(255,255,255,0.35)', display: 'inline-block',
                    animation: 'sr-bounce 1.2s infinite', animationDelay: `${d}ms`,
                  }} />
                ))}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>{/* closes inner flex/layout div */}
      </div>{/* closes outer scroll div */}

      {/* Composer */}
      <div style={{ padding: '10px 16px 20px', position: 'relative', zIndex: 5 }}>
        <Composer
          value={input}
          onChange={setInput}
          onSubmit={(files) => onSend(undefined, files)}
          onOpenVoice={onOpenVoice}
          isLoading={loading}
        />
      </div>
    </>
  )
}

// ─── Thread view ──────────────────────────────────────────

function ThreadView({
  msg, userQuestion, onBack, onOpenRaised,
}: {
  msg: Message
  userQuestion: string
  onBack: () => void
  onOpenRaised: () => void
}) {
  const time = new Date(msg.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })

  return (
    <>
      <div style={{ padding: '4px 22px 10px', position: 'relative', zIndex: 5 }}>
        <div style={{ position: 'absolute', left: 22, top: 4, zIndex: 6 }}>
          <BackBtn onClick={onBack} />
        </div>
      </div>

      <div className="sr-anim-up hide-scroll" style={{
        flex: 1, overflowY: 'auto', padding: '4px 22px 14px',
        scrollbarWidth: 'none' as const,
      }}>
        {/* Faded prior context */}
        <div style={{
          fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 300,
          lineHeight: 1.55, color: 'rgba(255,255,255,0.30)',
        }}>
          {msg.content.slice(0, 80)}…
        </div>

        {/* User prompt bubble */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <div style={{
            background: 'rgba(255,255,255,0.10)',
            border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: 18, borderTopRightRadius: 6,
            padding: '9px 13px',
            fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 300,
            color: 'rgba(255,255,255,0.92)', maxWidth: '78%',
            lineHeight: 1.4, backdropFilter: 'blur(20px)',
          }}>
            {userQuestion}
          </div>
        </div>

        {/* Short AI line */}
        <div style={{
          fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 300,
          color: 'rgba(255,255,255,0.55)', marginTop: 12, lineHeight: 1.5,
        }}>
          {msg.content.slice(0, 120)}
        </div>

        {/* Spotlit card — full card is tappable */}
        <div
          onClick={onOpenRaised}
          style={{
            marginTop: 12, padding: '14px 16px', borderRadius: 20,
            position: 'relative', overflow: 'hidden', color: '#fff',
            background: 'rgba(255,255,255,0.12)',
            border: '1px solid rgba(255,255,255,0.14)',
            backdropFilter: 'blur(28px) saturate(170%)',
            WebkitBackdropFilter: 'blur(28px) saturate(170%)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 16px 30px rgba(0,0,0,0.35)',
            cursor: 'pointer',
          }}
        >
          {/* Conic spotlight */}
          <div aria-hidden style={{
            position: 'absolute', inset: '-30%',
            background: 'conic-gradient(from 200deg at 30% 50%, transparent 0deg, rgba(255,255,255,0.16) 60deg, transparent 140deg)',
            pointerEvents: 'none',
          }} />

          <div style={{ position: 'relative' }}>
            {/* Header row */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.18em', color: 'var(--sr-cream)' }}>
                ASK PROMPT · YOURS
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.14em', color: 'rgba(255,255,255,0.5)' }}>
                {time}
              </span>
            </div>

            {/* Italic question in Fraunces */}
            <div style={{
              fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 400,
              letterSpacing: '-0.012em', lineHeight: 1.25, marginTop: 8,
              fontStyle: 'italic', color: 'rgba(255,255,255,0.88)',
            }}>
              "{userQuestion}"
            </div>

            {/* Separator + answer + open */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 14,
              marginTop: 12, paddingTop: 12,
              borderTop: '0.5px solid rgba(255,255,255,0.14)',
            }}>
              <div style={{ flex: 1, fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 300, color: 'rgba(255,255,255,0.85)', lineHeight: 1.4 }}>
                {msg.content.slice(0, 80)}
              </div>
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 400, color: '#fff', flexShrink: 0 }}>
                Open →
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Minimal composer pill */}
      <div style={{ padding: '8px 22px 22px', position: 'relative', zIndex: 5 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 999, padding: '10px 14px',
          fontFamily: 'var(--font-ui)', fontSize: 13,
          color: 'rgba(255,255,255,0.6)', fontWeight: 300,
        }}>
          <span style={{ flex: 1 }}>Reply or ask…</span>
          <div style={{
            width: 24, height: 24, borderRadius: '50%', background: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="11" height="11" viewBox="0 0 22 22" fill="none">
              <rect x="3"  y="9"  width="2" height="4"  rx="1" fill="#0a1f2a" />
              <rect x="7"  y="6"  width="2" height="10" rx="1" fill="#0a1f2a" />
              <rect x="11" y="4"  width="2" height="14" rx="1" fill="#0a1f2a" />
              <rect x="15" y="7"  width="2" height="8"  rx="1" fill="#0a1f2a" />
              <rect x="19" y="9"  width="2" height="4"  rx="1" fill="#0a1f2a" />
            </svg>
          </div>
        </div>
      </div>
    </>
  )
}

// ─── Raised view — wallet stack ───────────────────────────


function RaisedView({
  msg, userQuestion, activeDealIdx, onSetActive, onBack, sessionId, seenCardIds, onCardSeen,
}: {
  msg: Message
  userQuestion: string
  activeDealIdx: number
  onSetActive: (idx: number) => void
  onBack: () => void
  sessionId: string | null
  seenCardIds: Set<string>
  onCardSeen: (id: string) => void
}) {
  const router = useRouter()
  const deals  = msg.deals ?? []
  const active = deals[activeDealIdx]
  // others in their original order, preserving original indices
  const others = deals.map((d, i) => ({ d, i })).filter(x => x.i !== activeDealIdx)
  const time = new Date(msg.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  const pct = active ? Math.round(((active.matchScore ?? active.confidenceScore) ?? 0.75) * 100) : 75

  return (
    <>
      {/* Header */}
      <div style={{ padding: '4px 22px 12px', display: 'flex', gap: 14, alignItems: 'flex-start', position: 'relative', zIndex: 5 }}>
        <BackBtn onClick={onBack} />

        {/* Ask context */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.18em', color: 'rgba(255,255,255,0.55)' }}>
            ASK PROMPT · {time}
          </div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 400, fontStyle: 'italic', color: 'rgba(255,255,255,0.85)', marginTop: 2, lineHeight: 1.25 }}>
            "{userQuestion.slice(0, 55)}{userQuestion.length > 55 ? '…' : ''}"
          </div>
        </div>

        {/* Trends icon */}
        <a href="/trends" style={{ textDecoration: 'none' }}>
          <button style={{ width: 34, height: 34, borderRadius: '50%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, cursor: 'pointer', flexShrink: 0 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="none">
              <rect x="3"  y="14" width="3" height="7" fill="#fff" />
              <rect x="10" y="9"  width="3" height="12" fill="#fff" />
              <rect x="17" y="4"  width="3" height="17" fill="#fff" />
            </svg>
          </button>
        </a>
      </div>

      {/* Results label */}
      <div style={{ padding: '0 22px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'relative', zIndex: 5 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.18em', color: 'rgba(255,255,255,0.65)' }}>
          {deals.length} RESULTS · BY MATCH
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.18em', color: 'rgba(255,255,255,0.55)' }}>
          TAP TO RAISE
        </div>
      </div>

      {/* Wallet stage */}
      {/* Single scrollable container — active card + stacked deck flow together */}
      <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none', padding: '0 16px 16px' }}>
        {/* Active card — in normal flow */}
        {active && (
          <div
            className="sr-anim-up"
            style={{
              padding: '18px 20px 16px', borderRadius: 22, color: '#fff',
              background: 'rgba(255,255,255,0.12)',
              border: '1px solid rgba(255,255,255,0.14)',
              backdropFilter: 'blur(28px) saturate(170%)',
              WebkitBackdropFilter: 'blur(28px) saturate(170%)',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 16px 30px rgba(0,0,0,0.35)',
              transition: 'all .42s cubic-bezier(.22,1,.36,1)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {active.category && (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.18em', color: 'var(--sr-cream)' }}>
                    {(CATEGORY_LABELS[active.category] ?? active.category).toUpperCase()}
                  </span>
                )}
                {seenCardIds.has(active.id) && (
                  <span style={{ marginLeft: 8, fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.16em', color: 'rgba(255,255,255,0.5)' }}>
                    👁 VIEWED
                  </span>
                )}
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 300, letterSpacing: '-0.016em', marginTop: 6, lineHeight: 1.05 }}>
                  {active.extractedTitle?.split('–')[0]?.trim() ?? active.address ?? 'Untitled'}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, marginTop: 6, color: 'rgba(255,255,255,0.72)' }}>
                  {active.beds != null && `${active.beds}BR`}{active.squareFeet != null && ` · ${active.squareFeet.toLocaleString()} SF`}{active.neighborhood && ` · ${active.neighborhood.toUpperCase()}`}
                </div>
              </div>
              <MatchArc pct={pct} size={48} strokeWidth={1.5} />
            </div>

            {/* Price / date strip */}
            <div style={{
              display: 'flex', gap: 14, marginTop: 14, paddingTop: 12,
              borderTop: '0.5px solid rgba(255,255,255,0.14)',
              fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(255,255,255,0.88)',
            }}>
              {(active.price != null || active.maxPrice != null) && (
                <span>{formatPriceRange(active.minPrice, active.maxPrice, active.price)}</span>
              )}
              {active.availabilityDate && (
                <><span style={{ color: 'rgba(255,255,255,0.4)' }}>·</span><span>{active.availabilityDate}</span></>
              )}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button style={{
                flex: 1, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.18)',
                color: '#fff', borderRadius: 999, padding: '10px 0',
                fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 300, cursor: 'pointer',
              }}>
                Save
              </button>
              <button
                onClick={() => {
                  if (msg.interactionId) postInteraction({ interactionId: msg.interactionId, event: 'click', cardId: active.id, cardKind: active.category, rank: activeDealIdx })
                  onCardSeen(active.id)
                  router.push(`/opportunities/${active.id}${sessionId ? `?from=${sessionId}` : ''}`)
                }}
                style={{
                  flex: 1.5, background: '#fff', color: '#0a1f2a', border: 'none',
                  borderRadius: 999, padding: '10px 0',
                  fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 500, cursor: 'pointer',
                }}
              >
                Open ↗
              </button>
            </div>
            {active.streetEasyUrl && (
              <a
                href={active.streetEasyUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'block', textAlign: 'center', marginTop: 10,
                  fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.14em',
                  color: 'rgba(255,255,255,0.5)', textDecoration: 'none',
                }}
              >
                VIEW ON STREETEASY ↗
              </a>
            )}
          </div>
        )}

        {/* Wallet stack — absolutely positioned within a tall spacer that follows the active card */}
        {others.length > 0 && (
          <div style={{ position: 'relative', height: (others.length - 1) * 58 + 180, marginTop: 10 }}>
            {others.map(({ d, i }, si) => (
              <div
                key={d.id}
                onClick={() => {
                  if (msg.interactionId) postInteraction({ interactionId: msg.interactionId, event: 'click', cardId: d.id, cardKind: d.category, rank: i })
                  onCardSeen(d.id)
                  onSetActive(i)
                }}
                style={{
                  position: 'absolute', left: 0, right: 0,
                  top: si * 58,
                  height: 180,
                  padding: '14px 18px',
                  borderRadius: 22,
                  color: '#fff',
                  background: `rgba(255,255,255,${Math.min(0.18, 0.12 + si * 0.02)})`,
                  border: '1px solid rgba(255,255,255,0.14)',
                  backdropFilter: 'blur(28px) saturate(170%)',
                  WebkitBackdropFilter: 'blur(28px) saturate(170%)',
                  boxShadow: '0 -8px 22px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.18)',
                  cursor: 'pointer',
                  transition: 'top .3s cubic-bezier(.22,1,.36,1)',
                  zIndex: 10 + si,
                  opacity: seenCardIds.has(d.id) ? 0.6 : 1,
                }}
                onMouseEnter={e => { e.currentTarget.style.top = `${si * 58 - 6}px` }}
                onMouseLeave={e => { e.currentTarget.style.top = `${si * 58}px` }}
              >
                <div style={{ display: 'grid', gridTemplateColumns: '82px 1fr auto', gap: 10, alignItems: 'center', height: 28 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.16em', color: 'var(--sr-cream)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {seenCardIds.has(d.id) ? '👁 ' : ''}{(CATEGORY_LABELS[d.category] ?? d.category).slice(0, 12).toUpperCase()}
                  </span>
                  <span style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 400, letterSpacing: '-0.005em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {d.extractedTitle?.split('–')[0]?.trim() ?? d.address ?? 'Untitled'}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'rgba(255,255,255,0.78)' }}>
                    {d.price ? formatPriceRange(d.minPrice, d.maxPrice, d.price) : '—'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

// ─── File processing ──────────────────────────────────────

async function processFile(file: File): Promise<{ name: string; mimeType: string; type: 'image' | 'text' | 'binary'; content: string }> {
  return new Promise(resolve => {
    const reader = new FileReader()
    if (file.type.startsWith('image/')) {
      reader.onload = e => {
        const img = new Image()
        img.onload = () => {
          const canvas = document.createElement('canvas')
          let { width, height } = img
          const MAX = 1200
          if (width > MAX || height > MAX) {
            if (width > height) { height = Math.round(height * MAX / width); width = MAX }
            else { width = Math.round(width * MAX / height); height = MAX }
          }
          canvas.width = width; canvas.height = height
          canvas.getContext('2d')!.drawImage(img, 0, 0, width, height)
          resolve({ name: file.name, mimeType: 'image/jpeg', type: 'image', content: canvas.toDataURL('image/jpeg', 0.85).split(',')[1] })
        }
        img.src = e.target?.result as string
      }
      reader.readAsDataURL(file)
    } else if (file.type.startsWith('text/') || /\.(txt|csv|md|json|xml|yaml|yml)$/i.test(file.name)) {
      reader.onload = e => resolve({ name: file.name, mimeType: file.type, type: 'text', content: e.target?.result as string })
      reader.readAsText(file)
    } else {
      reader.onload = e => resolve({ name: file.name, mimeType: file.type, type: 'binary', content: (e.target?.result as string).split(',')[1] })
      reader.readAsDataURL(file)
    }
  })
}

// ─── Inner page ───────────────────────────────────────────

function ChatPageInner() {
  const searchParams = useSearchParams()
  const [cs, dispatch] = useReducer(reducer, INITIAL)
  const [messages, setMessages] = useState<Message[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  // Brief 3.0, Step 3 — cards Ryan has already tapped (from click history),
  // fetched once on mount and optimistically extended when he taps a card.
  const [seenCardIds, setSeenCardIds] = useState<Set<string>>(new Set())
  const markCardSeen = useCallback((id: string) => {
    setSeenCardIds(prev => prev.has(id) ? prev : new Set(prev).add(id))
  }, [])
  useEffect(() => {
    let alive = true
    fetch('/api/chat/seen-cards')
      .then(r => r.json())
      .then(d => { if (alive && Array.isArray(d.seenCardIds)) setSeenCardIds(new Set<string>(d.seenCardIds)) })
      .catch(() => { /* non-fatal — indicator just won't show */ })
    return () => { alive = false }
  }, [])
  const [chips, setChips] = useState<Chip[]>([])
  const [greeting, setGreeting] = useState(GREETINGS[0])
  const [showShader, setShowShader] = useState(true)
  const [sessionKey, setSessionKey] = useState(0)
  const [input, setInput] = useState('')
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setGreeting(pickGreeting())
    fetch('/api/chat/chips').then(r => r.json()).then(d => setChips(d.chips ?? [])).catch(() => {})
  }, [])

  useEffect(() => {
    const newParam     = searchParams.get('new')
    const sessionParam = searchParams.get('sessionId')
    if (newParam === '1') {
      dispatch({ type: 'RESET_NEW' })
      setCurrentSessionId(null)
      setMessages([])
      setShowShader(true); setSessionKey(k => k + 1)
      window.history.replaceState({}, '', '/chat')
    } else if (sessionParam) {
      const dealParam = searchParams.get('deal')
      setCurrentSessionId(sessionParam)
      setShowShader(true); setSessionKey(k => k + 1)
      setLoadingHistory(true)
      fetch(`/api/chat?sessionId=${sessionParam}`)
        .then(r => r.json())
        .then(d => {
          const msgs: Message[] = (d.messages ?? []).map((m: Record<string, unknown>) => ({
            ...m,
            deals: (m.dealsJson as unknown[] | undefined) ?? (m.deals as unknown[] | undefined) ?? [],
            suggestions: Array.isArray(m.suggestions) ? m.suggestions : [],
          }))
          setMessages(msgs)
          // Returning from an opportunity detail (?deal=<id>): re-raise the
          // message holding that deal so "back" lands on the exact results
          // cards instead of a blank chat.
          if (dealParam) {
            const target = msgs.find(m => (m.deals ?? []).some(dl => (dl as { id?: string }).id === dealParam))
            if (target) {
              const idx = (target.deals ?? []).findIndex(dl => (dl as { id?: string }).id === dealParam)
              dispatch({ type: 'OPEN_THREAD', msg: target })
              if (idx > 0) dispatch({ type: 'SET_ACTIVE', idx })
              return
            }
          }
          dispatch({ type: 'GO', to: 'memory' })
        })
        .finally(() => setLoadingHistory(false))
      window.history.replaceState({}, '', '/chat')
    }
  }, [searchParams])

  useEffect(() => {
    if (cs.view === 'memory' || cs.view === 'memory_new') {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, loading, cs.view])

  const handleNewChat = useCallback(() => {
    dispatch({ type: 'RESET_NEW' })
    setCurrentSessionId(null)
    setMessages([])
    setShowShader(true); setSessionKey(k => k + 1)
  }, [])

  async function send(text?: string, files?: File[]) {
    const msg = (text ?? input).trim()
    const hasFiles = (files?.length ?? 0) > 0
    if ((!msg && !hasFiles) || loading) return
    setInput('')
    if (cs.view === 'memory_new') dispatch({ type: 'GO', to: 'memory' })
    const displayMsg = hasFiles ? [msg, `📎 ${files!.map(f => f.name).join(', ')}`].filter(Boolean).join('\n') : msg
    setMessages(p => [...p, { id: crypto.randomUUID(), role: 'user', content: displayMsg, createdAt: new Date().toISOString() }])
    setLoading(true)
    try {
      const processed = hasFiles ? await Promise.all(files!.map(processFile)) : []
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg || '(see attached file)', files: processed, sessionId: currentSessionId }),
      })
      const data = await res.json()
      if (data.sessionId) setCurrentSessionId(data.sessionId)
      setMessages(p => [...p, { id: crypto.randomUUID(), role: 'assistant', content: data.response ?? data.error ?? 'Something went wrong.', deals: data.deals ?? [], suggestions: data.suggestions ?? [], seListings: data.seListings ?? [], seFilterUrl: data.seFilterUrl ?? null, interactionId: data.interactionId ?? undefined, createdAt: new Date().toISOString() }])
    } catch {
      setMessages(p => [...p, { id: crypto.randomUUID(), role: 'assistant', content: 'Something went wrong. Try again.', createdAt: new Date().toISOString() }])
    } finally { setLoading(false) }
  }

  function userQuestionFor(msg: Message): string {
    const idx = messages.findIndex(m => m.id === msg.id)
    for (let i = idx - 1; i >= 0; i--) { if (messages[i].role === 'user') return messages[i].content }
    return ''
  }

  return (
    <ChatSurfaceShell onNewChat={handleNewChat}>
      {showShader && <ChatShaderBg onDone={() => setShowShader(false)} />}
      {(cs.view === 'memory' || cs.view === 'memory_new') && (
        <MemoryView
          messages={messages} loading={loading} loadingHistory={loadingHistory}
          fresh={cs.view === 'memory_new'}
          chips={chips} greeting={greeting} sessionKey={sessionKey}
          input={input} setInput={setInput} onSend={send}
          onOpenThread={msg => dispatch({ type: 'OPEN_THREAD', msg })}
          onOpenVoice={() => setVoiceOpen(true)}
          bottomRef={bottomRef}
        />
      )}
      {cs.view === 'thread' && cs.focusedMsg && (
        <ThreadView
          msg={cs.focusedMsg}
          userQuestion={userQuestionFor(cs.focusedMsg)}
          onBack={() => dispatch({ type: 'BACK' })}
          onOpenRaised={() => dispatch({ type: 'GO', to: 'raised' })}
        />
      )}
      {cs.view === 'raised' && cs.focusedMsg && (
        <RaisedView
          msg={cs.focusedMsg}
          userQuestion={userQuestionFor(cs.focusedMsg)}
          activeDealIdx={cs.activeDealIdx}
          onSetActive={idx => dispatch({ type: 'SET_ACTIVE', idx })}
          onBack={() => dispatch({ type: 'BACK' })}
          sessionId={currentSessionId}
          seenCardIds={seenCardIds}
          onCardSeen={markCardSeen}
        />
      )}
      <VoiceConversation
        open={voiceOpen}
        sessionId={currentSessionId}
        onClose={async () => {
          setVoiceOpen(false)
          // Voice turns persist to the same ChatSession via /api/chat. Refetch on
          // close so they appear as normal text messages in the thread (ChatGPT-style).
          if (currentSessionId) {
            try {
              const res = await fetch(`/api/chat?sessionId=${currentSessionId}`)
              if (res.ok) {
                const d = await res.json()
                const msgs: Message[] = (d.messages ?? []).map((m: Record<string, unknown>) => ({
                  ...m,
                  deals: (m.dealsJson as unknown[] | undefined) ?? (m.deals as unknown[] | undefined) ?? [],
                  suggestions: Array.isArray(m.suggestions) ? m.suggestions : [],
                }))
                setMessages(msgs)
              }
            } catch { /* non-fatal — thread just won't refresh */ }
          }
        }}
        onNewSession={(id) => setCurrentSessionId(id)}
      />
      <style>{`
        @keyframes sr-bounce { 0%,80%,100%{transform:translateY(0);opacity:0.35} 40%{transform:translateY(-5px);opacity:0.9} }
      `}</style>
    </ChatSurfaceShell>
  )
}

export default function ChatPage() {
  return <Suspense><ChatPageInner /></Suspense>
}
