'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import type { MicVAD } from '@ricky0123/vad-web'

function splitSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by whitespace. Keep the
  // punctuation on the preceding sentence. Filter out empty results.
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

// Code-split the orb — Three.js + R3F is ~500KB gz, only pay it when voice mode opens.
const Orb = dynamic(() => import('@/components/ui/orb').then(m => m.Orb), { ssr: false })

type AgentState = null | 'thinking' | 'listening' | 'talking'

interface Props {
  open: boolean
  sessionId: string | null
  onClose: () => void
  onNewSession: (sessionId: string) => void
}

const IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 5 min of no speech → auto-close

// VAD assets (silero model + audio worklet) and the onnxruntime-web wasm are
// served from jsDelivr rather than committed to the repo (the wasm alone is
// ~100MB). Version-pinned so the fetched wasm matches the onnxruntime loader
// bundled via @ricky0123/vad-web. Voice mode is online-only anyway (chat / TTS
// / transcribe all hit the network), so a CDN asset dependency is consistent.
const VAD_BASE = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/'
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/'

export default function VoiceConversation({ open, sessionId, onClose, onNewSession }: Props) {
  const [agentState, setAgentState] = useState<AgentState>(null)
  const [error, setError] = useState<string | null>(null)

  // Refs for the audio pipeline — deliberately not state, to avoid re-renders on every frame.
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const inputAnalyserRef = useRef<AnalyserNode | null>(null)
  const outputAnalyserRef = useRef<AnalyserNode | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const mimeRef = useRef<string>('audio/webm')
  const vadRef = useRef<MicVAD | null>(null)
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null)
  const lastSpeechAtRef = useRef<number>(Date.now())
  const idleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const closedRef = useRef<boolean>(false)

  // Keep a ref of agentState so VAD callbacks (non-reactive) can read the latest.
  const agentStateRef = useRef<AgentState>(null)
  useEffect(() => { agentStateRef.current = agentState }, [agentState])

  // Read helpers passed to the orb as functions (called from its render loop).
  const getInputVolume = useCallback(() => {
    const an = inputAnalyserRef.current
    if (!an) return 0
    const data = new Uint8Array(an.frequencyBinCount)
    an.getByteFrequencyData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
    const rms = Math.sqrt(sum / data.length) / 255
    return Math.min(1, rms * 2)
  }, [])

  const getOutputVolume = useCallback(() => {
    const an = outputAnalyserRef.current
    if (!an) return 0
    const data = new Uint8Array(an.frequencyBinCount)
    an.getByteFrequencyData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
    const rms = Math.sqrt(sum / data.length) / 255
    return Math.min(1, rms * 2)
  }, [])

  const close = useCallback(() => {
    if (closedRef.current) return
    closedRef.current = true
    try { vadRef.current?.destroy() } catch { /* noop */ }
    vadRef.current = null
    try { if (recorderRef.current?.state === 'recording') recorderRef.current.stop() } catch { /* noop */ }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause()
      ttsAudioRef.current.src = ''
      ttsAudioRef.current = null
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {})
      audioCtxRef.current = null
    }
    if (idleTimerRef.current) {
      clearInterval(idleTimerRef.current)
      idleTimerRef.current = null
    }
    onClose()
  }, [onClose])

  // The full voice→transcribe→chat→tts pipeline for a single utterance.
  const handleUtterance = useCallback(async (blob: Blob, mimeType: string) => {
    try {
      // 1. Transcribe
      const buf = await blob.arrayBuffer()
      const bytes = new Uint8Array(buf)
      let bin = ''
      const chunk = 0x8000
      for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
      const audioB64 = btoa(bin)
      const trRes = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: { mimeType, content: audioB64 } }),
      })
      if (!trRes.ok) throw new Error(`transcribe ${trRes.status}`)
      const trData = await trRes.json()
      const transcript = (trData.transcript ?? '').trim()
      if (!transcript) { setAgentState('listening'); return }

      // 2. Chat (same endpoint as text mode, inherits Brief 12 persona + Brief 11 guard)
      const chatRes = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: transcript, sessionId }),
      })
      if (!chatRes.ok) throw new Error(`chat ${chatRes.status}`)
      const chatData = await chatRes.json()
      if (!sessionId && chatData.sessionId) onNewSession(chatData.sessionId)
      const responseText = (chatData.response ?? '').trim()
      if (!responseText) { setAgentState('listening'); return }

      // 3. TTS — sentence-chunked. Split the response, fire N parallel /api/tts
      // POSTs, then play them in order. Later sentences generate while earlier
      // ones play, so Drift starts speaking as soon as the FIRST mp3 arrives
      // (~500ms) instead of after the whole-response mp3 (~1–1.5s).
      setAgentState('talking')

      const sentences = splitSentences(responseText)
      if (sentences.length === 0) { setAgentState('listening'); return }

      const sentenceUrlPromises: Array<Promise<string>> = sentences.map(async (s) => {
        const r = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: s }),
        })
        if (!r.ok) throw new Error(`tts sentence: ${r.status}`)
        const b = await r.blob()
        return URL.createObjectURL(b)
      })

      const audioEl = ttsAudioRef.current
      if (!audioEl) return

      // Play each sentence in order. `await` inside the loop naturally waits for
      // the current sentence to arrive AND finish before starting the next.
      for (let i = 0; i < sentenceUrlPromises.length; i++) {
        let url: string
        try {
          url = await sentenceUrlPromises[i]
        } catch (e) {
          console.warn('[VoiceConversation] sentence tts failed, skipping', i, e)
          continue
        }
        audioEl.src = url
        await new Promise<void>((resolve, reject) => {
          audioEl.onended = () => { URL.revokeObjectURL(url); resolve() }
          audioEl.onerror = () => { URL.revokeObjectURL(url); reject(new Error('audio error')) }
          audioEl.play().catch(reject)
        })
      }

      // All sentences played — return to listening.
      setAgentState('listening')
      lastSpeechAtRef.current = Date.now()
    } catch (e) {
      console.error('[VoiceConversation] utterance failed', e)
      setError(String((e as Error).message ?? e))
      setAgentState('listening')
    }
  }, [sessionId, onNewSession])

  // Main setup effect — runs when the modal opens.
  useEffect(() => {
    if (!open) return
    closedRef.current = false
    setError(null)
    setAgentState(null)
    lastSpeechAtRef.current = Date.now()

    let cancelled = false

    ;(async () => {
      try {
        // Mic stream — one stream shared by the VAD, the input analyser, and the recorder.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream

        // Audio context + input analyser
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        const ctx = new AudioCtx()
        audioCtxRef.current = ctx
        // iOS starts the context suspended; the opening tap is our user gesture.
        if (ctx.state === 'suspended') { try { await ctx.resume() } catch { /* noop */ } }
        const source = ctx.createMediaStreamSource(stream)
        const inAn = ctx.createAnalyser()
        inAn.fftSize = 256
        source.connect(inAn)
        inputAnalyserRef.current = inAn

        // TTS audio element + output analyser
        const audioEl = new Audio()
        audioEl.crossOrigin = 'anonymous'
        ttsAudioRef.current = audioEl
        const ttsSource = ctx.createMediaElementSource(audioEl)
        const outAn = ctx.createAnalyser()
        outAn.fftSize = 256
        ttsSource.connect(outAn)
        outAn.connect(ctx.destination)
        outputAnalyserRef.current = outAn

        // MediaRecorder — starts/stops on VAD boundaries. webm/mp4 keeps the
        // /api/transcribe payload identical to the old push-to-talk path.
        const mimeType = MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : ''
        if (!mimeType) throw new Error('No supported audio MIME type')
        mimeRef.current = mimeType
        const recorder = new MediaRecorder(stream, { mimeType })
        recorderRef.current = recorder
        recorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data) }
        recorder.onstop = async () => {
          const parts = chunksRef.current
          chunksRef.current = []
          if (parts.length === 0) { setAgentState('listening'); return }
          const blob = new Blob(parts, { type: mimeRef.current })
          await handleUtterance(blob, mimeRef.current)
        }

        // VAD — v0.0.30 has no external-stream option; feed it our shared
        // stream via getStream and let onSpeechStart/End gate the recorder.
        const { MicVAD } = await import('@ricky0123/vad-web')
        if (cancelled) return
        const vad = await MicVAD.new({
          getStream: async () => streamRef.current ?? stream,
          startOnLoad: false,
          baseAssetPath: VAD_BASE,
          onnxWASMBasePath: ORT_BASE,
          onSpeechStart: () => {
            lastSpeechAtRef.current = Date.now()
            // Only capture while listening — ignores Drift's own voice bleeding
            // back into the mic while it's talking/thinking (barge-in guard).
            if (agentStateRef.current === 'listening' && recorderRef.current?.state !== 'recording') {
              try { chunksRef.current = []; recorderRef.current?.start() } catch { /* noop */ }
            }
          },
          onSpeechEnd: () => {
            lastSpeechAtRef.current = Date.now()
            if (recorderRef.current?.state === 'recording') {
              try { recorderRef.current.stop() } catch { /* noop */ }
              setAgentState('thinking')
            }
          },
        })
        if (cancelled) { try { vad.destroy() } catch { /* noop */ }; return }
        vadRef.current = vad
        await vad.start()
        setAgentState('listening')

        // Idle timer
        idleTimerRef.current = setInterval(() => {
          if (Date.now() - lastSpeechAtRef.current > IDLE_TIMEOUT_MS) close()
        }, 15_000)
      } catch (e) {
        console.error('[VoiceConversation] setup failed', e)
        setError(String((e as Error).message ?? e))
        setAgentState(null)
      }
    })()

    return () => {
      cancelled = true
      close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, close])

  if (!open) return null

  return (
    <div
      className="sr-bg"
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 24,
        touchAction: 'none',
      }}
    >
      <button
        onClick={close}
        aria-label="Close voice conversation"
        style={{
          position: 'absolute', top: 20, right: 20, zIndex: 101,
          width: 40, height: 40, borderRadius: '50%',
          background: 'rgba(255,255,255,0.08)',
          border: '1px solid rgba(255,255,255,0.15)',
          color: '#fff', fontSize: 20, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >×</button>

      {/* Orb — the sole visual focus during voice mode (180×180, centered) */}
      <div style={{ width: 180, height: 180 }}>
        <Orb
          agentState={agentState}
          volumeMode="manual"
          getInputVolume={getInputVolume}
          getOutputVolume={getOutputVolume}
        />
      </div>

      {/* Status label — small, directly below orb (spacing owned by container gap) */}
      <div style={{
        color: 'rgba(255,255,255,0.5)',
        fontSize: 12,
        fontFamily: 'var(--font-ui)',
        fontWeight: 300,
        textAlign: 'center',
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
      }}>
        {error
          ? <span style={{ color: 'rgba(255,120,120,0.85)' }}>{error}</span>
          : agentState === 'listening' ? 'Listening'
          : agentState === 'thinking'  ? 'Thinking'
          : agentState === 'talking'   ? 'Speaking'
          : 'Connecting'}
      </div>
    </div>
  )
}
