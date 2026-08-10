'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

type State = 'idle' | 'recording' | 'transcribing' | 'error'

interface Props {
  onTranscript: (text: string) => void
  disabled?: boolean
}

const MAX_MS = 90_000
const MIN_MS = 200

function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm'
  if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4'
  return null
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

export default function MicButton({ onTranscript, disabled }: Props) {
  const [state, setState] = useState<State>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const startedAtRef = useRef<number>(0)
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelledRef = useRef<boolean>(false)
  const mimeRef = useRef<string>('audio/webm')

  const releaseStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current)
      autoStopTimerRef.current = null
    }
  }, [])

  useEffect(() => () => releaseStream(), [releaseStream])

  useEffect(() => {
    if (state !== 'error') return
    const t = setTimeout(() => { setState('idle'); setErrorMsg(null) }, 3500)
    return () => clearTimeout(t)
  }, [state])

  async function uploadAndTranscribe(blob: Blob, mimeType: string) {
    setState('transcribing')
    try {
      const base64 = await blobToBase64(blob)
      const res = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: { mimeType, content: base64 } }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      const text = (data.transcript ?? '').trim()
      if (text) onTranscript(text)
      setState('idle')
    } catch (e) {
      console.error('[MicButton] transcribe failed', e)
      setErrorMsg('Could not transcribe. Try again.')
      setState('error')
    }
  }

  async function start() {
    if (disabled || state !== 'idle') return
    setErrorMsg(null)
    cancelledRef.current = false

    const mimeType = pickMimeType()
    if (!mimeType) {
      setErrorMsg('Voice input not supported in this browser.')
      setState('error')
      return
    }
    mimeRef.current = mimeType

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      const err = e as DOMException
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
        setErrorMsg('Microphone access denied. Enable in browser settings.')
      } else {
        setErrorMsg('Could not access microphone.')
      }
      setState('error')
      return
    }

    streamRef.current = stream
    const rec = new MediaRecorder(stream, { mimeType })
    recorderRef.current = rec
    chunksRef.current = []
    startedAtRef.current = Date.now()

    rec.ondataavailable = e => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data) }
    rec.onstop = () => {
      const elapsed = Date.now() - startedAtRef.current
      const parts = chunksRef.current
      const mimeType = mimeRef.current
      releaseStream()
      if (cancelledRef.current || elapsed < MIN_MS || parts.length === 0) {
        setState('idle')
        return
      }
      const blob = new Blob(parts, { type: mimeType })
      uploadAndTranscribe(blob, mimeType)
    }

    rec.start()
    setState('recording')
    autoStopTimerRef.current = setTimeout(() => {
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
    }, MAX_MS)
  }

  function stop() {
    if (state !== 'recording') return
    const rec = recorderRef.current
    if (!rec) return
    const elapsed = Date.now() - startedAtRef.current
    if (elapsed < MIN_MS) cancelledRef.current = true
    if (rec.state === 'recording') rec.stop()
  }

  const isRecording = state === 'recording'
  const isBusy = state === 'transcribing'

  const bg = isRecording
    ? 'rgba(220,70,70,0.85)'
    : isBusy
    ? 'rgba(255,255,255,0.16)'
    : 'rgba(255,255,255,0.08)'
  const border = isRecording
    ? '1px solid rgba(255,120,120,0.6)'
    : '1px solid rgba(255,255,255,0.22)'

  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        disabled={disabled || isBusy}
        onMouseDown={start}
        onMouseUp={stop}
        onMouseLeave={() => { if (isRecording) stop() }}
        onTouchStart={e => { e.preventDefault(); start() }}
        onTouchEnd={e => { e.preventDefault(); stop() }}
        onContextMenu={e => e.preventDefault()}
        aria-label={isRecording ? 'Recording — release to send' : 'Hold to record voice'}
        aria-pressed={isRecording}
        style={{
          width: 32, height: 32, borderRadius: '50%',
          background: bg, border,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: disabled || isBusy ? 'default' : 'pointer',
          padding: 0,
          transition: 'background 0.15s, border-color 0.15s',
          opacity: disabled ? 0.5 : 1,
          touchAction: 'none',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          WebkitTouchCallout: 'none',
          animation: isRecording ? 'sr-mic-pulse 1.1s ease-in-out infinite' : undefined,
        }}
      >
        {isBusy ? (
          <span style={{
            width: 12, height: 12, borderRadius: '50%',
            border: '1.5px solid rgba(255,255,255,0.3)',
            borderTopColor: '#fff',
            display: 'inline-block',
            animation: 'sr-mic-spin 0.8s linear infinite',
          }} />
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round">
            <rect x="9" y="3" width="6" height="12" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
        )}
      </button>
      {errorMsg && (
        <div
          role="alert"
          style={{
            position: 'absolute', bottom: 'calc(100% + 6px)', right: 0,
            background: 'rgba(220,70,70,0.92)',
            border: '1px solid rgba(255,180,180,0.4)',
            color: '#fff',
            borderRadius: 10,
            padding: '6px 10px',
            fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 300,
            whiteSpace: 'nowrap',
            maxWidth: 280,
            zIndex: 20,
          }}
        >
          {errorMsg}
        </div>
      )}
      <style>{`
        @keyframes sr-mic-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(220,70,70,0.55) } 50% { box-shadow: 0 0 0 6px rgba(220,70,70,0) } }
        @keyframes sr-mic-spin  { to { transform: rotate(360deg) } }
      `}</style>
    </span>
  )
}
