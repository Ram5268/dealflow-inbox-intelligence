'use client'

import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { MicVAD } from '@ricky0123/vad-web'
import { Mic, MicOff, Settings, ThumbsDown, ThumbsUp, X } from 'lucide-react'
import Glow, { type GlowTone } from '@/components/voice/Glow'
import SettingsSheet from '@/components/voice/SettingsSheet'
import styles from '@/components/voice/voice.module.css'
import { voiceItalic, voiceSerif } from '@/components/voice/fonts'
import { initialVoiceState, voiceReducer, type Phase, type Turn, type VoiceEvent } from '@/components/voice/state'
import { ORT_BASE, VAD_BASE, VOICE_TIMING as T, shouldCommit } from '@/components/voice/config'
import { levelOf, spokenCount } from '@/components/voice/text'
import { openTranscriptLink, VoiceSessionError, type TranscriptLink } from '@/components/voice/realtime'
import { previewClip, speakSentences, type Speech } from '@/components/voice/player'
import { sendVoiceTurn } from '@/components/voice/chat'
import { readSettings, writeSettings, type VoiceSettings } from '@/components/voice/settings'
import { sendThumb, type Thumb } from '@/components/voice/feedback'
import { SPEEDS } from '@/lib/voice/voices'

const MIC_OPEN: Phase[] = ['listening', 'hearing', 'finalizing']
const BLOCKED_TEXT = {
  mic: 'Drift needs the microphone for voice mode. Allow it in your browser settings, then try again.',
  connect: 'Couldn’t start voice mode. Check your connection and try again.',
  limit: 'Voice mode has hit its hourly limit. Try again in a bit.',
}

interface Props {
  open: boolean
  sessionId: string | null
  onClose: () => void
  onNewSession: (sessionId: string) => void
  demo?: string | null // dev-only parity demo, see components/voice/demo.ts
}

// Live device/network handles: refs, not state, so audio frames never re-render.
interface Rig {
  stream?: MediaStream; ctx?: AudioContext; vad?: MicVAD; link?: TranscriptLink; speech?: Speech
  mic?: AnalyserNode; out?: AnalyserNode; bytes?: Uint8Array<ArrayBuffer> // glow levels
  preview?: AudioBufferSourceNode // settings-sheet voice sample
}

// Stop everything: audio, transcription link, VAD and the mic itself.
function release(r: Rig) {
  r.speech?.stop()
  try { r.preview?.stop() } catch { /* not started */ }
  r.vad?.destroy().catch(() => {})
  r.link?.close()
  r.stream?.getTracks().forEach(t => t.stop())
  if (r.ctx && r.ctx.state !== 'closed') r.ctx.close().catch(() => {})
  for (const k of Object.keys(r) as Array<keyof Rig>) delete r[k]
}

// Brief 36 — voice mode: listening → Ryan talks (live transcript) → thinking →
// Drift speaks (text darkens with the audio) → listening, until closed. The
// reducer (voice/state.ts) owns the rules; the effects below do the I/O when
// the phase changes.
const noSubscribe = () => () => {}
const localStore = () => { try { return window.localStorage } catch { return undefined } }

export default function VoiceConversation(props: Props) {
  // Portal to <body>: the chat shell is transformed, which would pin a fixed
  // overlay to the shell instead of the screen. Client-only (no document on SSR).
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false)
  return props.open && isClient ? createPortal(<VoiceMode {...props} />, document.body) : null
}

function VoiceMode({ sessionId, onClose, onNewSession, demo = null }: Props) {
  const [s, dispatch] = useReducer(voiceReducer, initialVoiceState)
  const [attempt, setAttempt] = useState(0)
  const [settings, setSettings] = useState<VoiceSettings>(() => readSettings(localStore()))
  const [sheetOpen, setSheetOpen] = useState(false)
  const choice = useRef({ voice: settings.voice, speed: SPEEDS[settings.speed] })
  const rig = useRef<Rig>({})
  const session = useRef(sessionId) // latest session id; every turn reuses it
  const phase = useRef<Phase>(s.phase)
  const lastDeltaAt = useRef(0)
  const lastActivity = useRef(0)
  const fakeLevel = useRef<((t: number) => number) | null>(null)
  const callbacks = useRef({ onClose, onNewSession })
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => { phase.current = s.phase }, [s.phase])
  useEffect(() => { callbacks.current = { onClose, onNewSession } }, [onClose, onNewSession])
  useEffect(() => { choice.current = { voice: settings.voice, speed: SPEEDS[settings.speed] } }, [settings])

  const close = useCallback(() => {
    if (phase.current === 'closing') return
    phase.current = 'closing'
    release(rig.current)
    dispatch({ type: 'close' })
    setTimeout(() => callbacks.current.onClose(), T.closeFadeMs)
  }, [])

  // Open: mic first (Safari hides ICE candidates until it has mic permission),
  // then the audio graph, the transcription link and the VAD.
  useEffect(() => {
    if (demo) return
    const r: Rig = {} // this run's handles; a stale run can't touch the next one's
    rig.current = r
    let cancelled = false
    ;(async () => {
      let stream: MediaStream
      try {
        stream = r.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      } catch {
        if (!cancelled) dispatch({ type: 'blocked', reason: 'mic' })
        return
      }
      try {
        if (cancelled) throw new Error('closed')
        const ctx = (r.ctx = new AudioContext())
        // iOS starts the context suspended; the opening tap + live mic let it run.
        if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
        r.mic = Object.assign(ctx.createAnalyser(), { fftSize: 256 })
        r.out = Object.assign(ctx.createAnalyser(), { fftSize: 256 })
        ctx.createMediaStreamSource(stream).connect(r.mic)
        r.out.connect(ctx.destination)
        const { MicVAD } = await import('@ricky0123/vad-web')
        const settled = await Promise.allSettled([
          openTranscriptLink(stream, {
            delta: text => { lastDeltaAt.current = performance.now(); dispatch({ type: 'delta', text }) },
            final: text => dispatch({ type: 'final', text }),
            lost: () => dispatch({ type: 'blocked', reason: 'connect' }),
          }).then(link => { r.link = link }),
          MicVAD.new({
            // The VAD's default pause stops the tracks; this mic is shared.
            getStream: async () => stream, pauseStream: async () => {}, resumeStream: async () => stream,
            audioContext: ctx, baseAssetPath: VAD_BASE, onnxWASMBasePath: ORT_BASE,
            redemptionMs: T.vadRedemptionMs, minSpeechMs: T.vadMinSpeechMs,
            onSpeechStart: () => { lastActivity.current = Date.now(); dispatch({ type: 'speechStart' }) },
            onSpeechEnd: () => { lastActivity.current = Date.now(); dispatch({ type: 'speechEnd' }) },
            onVADMisfire: () => dispatch({ type: 'misfire' }),
          }).then(vad => { r.vad = vad }),
        ])
        const failure = settled.find(x => x.status === 'rejected')
        if (failure) throw failure.reason
        if (cancelled) throw new Error('closed')
        await r.vad?.start()
        lastActivity.current = Date.now()
        dispatch({ type: 'ready' })
      } catch (err) {
        release(r)
        if (!cancelled) dispatch({ type: 'blocked', reason: err instanceof VoiceSessionError && err.status === 429 ? 'limit' : 'connect' })
      }
    })()
    return () => { cancelled = true; release(r) }
  }, [attempt, demo])

  // The mic reaches the transcriber only while Ryan has the floor and isn't
  // muted or in settings (Drift's voice is never transcribed). A fresh floor starts clean,
  // and is cleared again once any tail caught as the mic reopened has passed
  // (cancelled if Ryan starts talking first).
  useEffect(() => {
    const r = rig.current
    r.stream?.getAudioTracks().forEach(t => { t.enabled = !s.muted && !sheetOpen && MIC_OPEN.includes(s.phase) })
    if (s.phase === 'blocked') release(r) // never leave the mic open after an error
    if (s.phase !== 'listening') return
    r.link?.clear()
    const settle = window.setTimeout(() => r.link?.clear(), T.listenSettleMs)
    return () => clearTimeout(settle)
  }, [s.phase, s.muted, sheetOpen])

  // End of Ryan's turn: commit once the live text settles, then wait (bounded)
  // for the final transcript.
  useEffect(() => {
    if (s.phase !== 'finalizing') return
    const endAt = performance.now()
    let timer = 0
    const poll = () => {
      if (!shouldCommit(performance.now(), endAt, lastDeltaAt.current)) { timer = window.setTimeout(poll, 50); return }
      rig.current.link?.commit()
      timer = window.setTimeout(() => dispatch({ type: 'finalTimeout' }), T.finalTimeoutMs)
    }
    poll()
    return () => clearTimeout(timer)
  }, [s.phase])

  // Thinking: ask Drift. Deals/suggestions are ignored here; they show up in
  // the thread when voice mode closes and the chat page refetches it.
  const pending = s.phase === 'thinking' ? s.turns[s.turns.length - 1] : undefined
  useEffect(() => {
    if (!pending || demo) return
    let current = true
    const before = session.current
    sendVoiceTurn(pending.user, session).then(result => {
      if (session.current && session.current !== before) callbacks.current.onNewSession(session.current)
      if (!current) return
      dispatch(result.ok ? { type: 'reply', text: result.text, interactionId: result.interactionId } : { type: 'failed', message: result.error })
    })
    return () => { current = false }
  }, [pending, demo])

  // Speaking: play the reply; each sentence darkens as its audio starts.
  // Leaving the phase (tap to interrupt, close) stops the audio at once.
  const reply = s.phase === 'speaking' ? s.turns[s.turns.length - 1]?.reply : null
  useEffect(() => {
    const r = rig.current
    const { ctx, out } = r
    if (!reply || !ctx || !out) return
    const speech = (r.speech = speakSentences(ctx, out, reply.sentences, choice.current, T.sentenceGapS))
    let raf = 0
    let shown = 0
    const tick = () => {
      const n = spokenCount(speech.starts, ctx.currentTime)
      if (n !== shown) dispatch({ type: 'spoken', count: (shown = n) })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    speech.done.then(finished => { lastActivity.current = Date.now(); if (finished) dispatch({ type: 'doneSpeaking' }) })
    return () => { cancelAnimationFrame(raf); speech.stop() }
  }, [reply])

  // A new turn scrolls its bubble to the top; while Drift speaks, the current
  // sentence stays in view.
  const turnCount = s.turns.length
  const spoken = s.turns[s.turns.length - 1]?.spoken ?? 0
  useEffect(() => {
    scroller.current?.lastElementChild?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [turnCount])
  useEffect(() => {
    if (spoken) scroller.current?.querySelector(`[data-last] [data-si="${spoken - 1}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [spoken])

  // Escape closes the settings sheet, then voice mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (sheetOpen) setSheetOpen(false); else close() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close, sheetOpen])

  // 5 idle minutes close; the screen stays awake while open.
  useEffect(() => {
    if (demo) return
    const idle = setInterval(() => { if (phase.current === 'listening' && Date.now() - lastActivity.current > T.idleCloseMs) close() }, 15_000)
    let lock: WakeLockSentinel | null = null
    const wake = () => { if (document.visibilityState === 'visible') navigator.wakeLock?.request('screen').then(l => { lock = l }).catch(() => {}) }
    wake()
    document.addEventListener('visibilitychange', wake)
    return () => {
      clearInterval(idle)
      document.removeEventListener('visibilitychange', wake)
      lock?.release().catch(() => {})
    }
  }, [close, demo])

  // Dev-only parity demo: canned events + a fake audio level.
  useEffect(() => {
    if (process.env.NODE_ENV === 'production' || !demo) return
    const timers: number[] = []
    let off = false
    import('@/components/voice/demo').then(({ DEMO_STATES, demoTimeline, demoLevel }) => {
      if (off) return
      fakeLevel.current = demoLevel
      const steps = DEMO_STATES[demo]?.map((e): [number, VoiceEvent] => [0, e]) ?? demoTimeline()
      for (const [ms, e] of steps) timers.push(window.setTimeout(() => dispatch(e), ms))
    })
    return () => { off = true; timers.forEach(clearTimeout) }
  }, [demo])

  const updateSettings = (next: VoiceSettings) => { setSettings(next); writeSettings(localStore(), next) }
  const preview = useCallback((voice: string) => {
    const r = rig.current
    const { ctx, out } = r
    if (!ctx || !out) return
    previewClip(ctx, { voice, speed: choice.current.speed }).then(buf => {
      try { r.preview?.stop() } catch { /* not started */ }
      const src = (r.preview = ctx.createBufferSource())
      src.buffer = buf
      src.connect(out)
      src.start()
    }).catch(() => {})
  }, [])

  const getLevel = useCallback(() => {
    const p = phase.current
    if (fakeLevel.current) return p === 'hearing' || p === 'speaking' ? fakeLevel.current(performance.now()) : 0
    const r = rig.current
    const an = p === 'speaking' ? r.out : MIC_OPEN.includes(p) ? r.mic : undefined
    if (!an) return 0
    const bytes = (r.bytes ??= new Uint8Array(an.fftSize))
    an.getByteTimeDomainData(bytes)
    return levelOf(bytes)
  }, [])

  const tone: GlowTone = s.phase === 'speaking' ? 'coral' : s.phase === 'thinking' ? 'thinking' : 'blue'
  const idleText = s.muted ? 'Muted' : MIC_OPEN.includes(s.phase) ? 'Start talking' : null
  const icon = { size: 21, strokeWidth: 1.75 }

  return (
    <div
      role="dialog" aria-modal="true" aria-label="Voice conversation with Drift"
      className={`${styles.overlay} ${voiceSerif.variable} ${voiceItalic.variable}`}
      data-tone={tone} data-closing={s.phase === 'closing'}
      style={demo ? ({ '--sat': '59px', '--sab': '34px' } as CSSProperties) : undefined}
    >
      <Glow tone={tone} dim={s.muted} getLevel={getLevel} />

      {/* Tapping the conversation while Drift speaks interrupts it. */}
      <div ref={scroller} className={styles.scroll} onClick={() => dispatch({ type: 'interrupt' })}>
        {s.turns.map((t, i) => (
          <TurnView key={t.id} turn={t} last={i === s.turns.length - 1} speaking={i === s.turns.length - 1 && s.phase === 'speaking'} />
        ))}
      </div>

      {s.phase === 'blocked' && s.blocked ? (
        <div className={styles.center} role="alert">
          {BLOCKED_TEXT[s.blocked]}
          <button className={styles.retry} onClick={() => { dispatch({ type: 'retry' }); setAttempt(a => a + 1) }}>Try again</button>
        </div>
      ) : !s.turns.length && idleText ? (
        <p className={styles.center} data-hide={!!s.live}>{idleText}</p>
      ) : null}

      {s.live ? (
        <p className={styles.live}>
          {s.live.trimStart().split(/(\s+)/).map((w, i) => <span key={i} className={styles.word}>{w}</span>)}
        </p>
      ) : s.notice ? (
        <p className={styles.notice} role="status">{s.notice}</p>
      ) : null}

      <div className={styles.controls}>
        <button
          className={`${styles.btn} ${styles.settings}`} aria-label="Voice settings"
          onClick={() => { dispatch({ type: 'interrupt' }); setSheetOpen(true) }}
        >
          <Settings {...icon} />
        </button>
        <button
          className={`${styles.btn} ${styles.mic}`} aria-pressed={s.muted} onClick={() => dispatch({ type: 'toggleMute' })}
          aria-label={s.muted ? 'Unmute microphone' : 'Mute microphone'}
        >
          {s.muted ? <MicOff {...icon} /> : <Mic {...icon} />}
        </button>
        <button className={`${styles.btn} ${styles.close}`} aria-label="Close voice mode" onClick={close}><X {...icon} /></button>
      </div>

      {sheetOpen && (
        <SettingsSheet settings={settings} onChange={updateSettings} onPreview={preview} onClose={() => setSheetOpen(false)} />
      )}
    </div>
  )
}

function TurnView({ turn, last, speaking }: { turn: Turn; last: boolean; speaking: boolean }) {
  const { reply } = turn
  return (
    <section className={styles.turn} data-last={last || undefined}>
      <div className={styles.bubble}>{turn.user}</div>
      {reply && (
        <div className={styles.reply}>
          {reply.paragraphs.map((p, pi) => (
            <p key={pi} style={{ animationDelay: `${pi * 80}ms` }}>
              {p.sentences.map((si, k) => {
                const text = reply.sentences[si]
                const lead = k === 0 && p.lead && text.startsWith(p.lead) ? p.lead : ''
                return (
                  <span key={si} data-si={si} className={`${styles.sentence} ${si < turn.spoken ? styles.spoken : ''}`}>
                    {lead && <b>{lead}</b>}{text.slice(lead.length)}{' '}
                  </span>
                )
              })}
            </p>
          ))}
        </div>
      )}
      {reply && turn.interactionId && !speaking && <Thumbs interactionId={turn.interactionId} />}
    </section>
  )
}

// Thumbs reuse the chat's feedback (up → helpful, down → wrong_result). One
// vote per reply; the picked thumb stays filled. Taps don't interrupt Drift.
function Thumbs({ interactionId }: { interactionId: string }) {
  const [picked, setPicked] = useState<Thumb | null>(null)
  const pick = (thumb: Thumb) => (e: React.MouseEvent) => {
    e.stopPropagation()
    if (picked) return
    setPicked(thumb)
    sendThumb(interactionId, thumb)
  }
  const glyph = (thumb: Thumb) => ({ size: 18, strokeWidth: 1.8, fill: picked === thumb ? 'currentColor' : 'none' })
  return (
    <div className={styles.thumbs}>
      <button aria-label="Good reply" aria-pressed={picked === 'up'} onClick={pick('up')}><ThumbsUp {...glyph('up')} /></button>
      <button aria-label="Bad reply" aria-pressed={picked === 'down'} onClick={pick('down')}><ThumbsDown {...glyph('down')} /></button>
    </div>
  )
}
