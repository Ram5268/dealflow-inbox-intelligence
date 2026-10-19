'use client'

import { useEffect, useRef, useState } from 'react'
import type { MicVAD } from '@ricky0123/vad-web'
import { Mic, Square } from 'lucide-react'
import { showToast } from '@/components/Toast'
import { ORT_BASE, VAD_BASE, VOICE_TIMING } from '@/components/voice/config'

interface Props {
  onText: (text: string) => void
  disabled?: boolean
}

interface Take { stream: MediaStream; recorder: MediaRecorder; vad?: MicVAD }

const toBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
  reader.onerror = reject
  reader.readAsDataURL(blob)
})

// Brief 36 PR B — composer dictation: tap to record, tap again (or just pause)
// to stop. The audio goes through /api/transcribe and the text lands in the
// input box, unsent.
export default function MicButton({ onText, disabled }: Props) {
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const take = useRef<Take | null>(null)

  const stop = () => { if (take.current?.recorder.state === 'recording') take.current.recorder.stop() }
  useEffect(() => () => { take.current?.vad?.destroy().catch(() => {}); take.current?.stream.getTracks().forEach(t => t.stop()) }, [])

  async function start() {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      showToast('Microphone access is off for DealFlow.')
      return
    }
    const mimeType = ['audio/webm', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t))
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    const chunks: Blob[] = []
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
    recorder.onstop = async () => {
      take.current?.vad?.destroy().catch(() => {})
      take.current = null
      stream.getTracks().forEach(t => t.stop())
      setState('transcribing')
      try {
        const type = recorder.mimeType || mimeType || 'audio/webm'
        const res = await fetch('/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio: { mimeType: type, content: await toBase64(new Blob(chunks, { type })) } }),
        })
        const data = await res.json().catch(() => null)
        const text = res.ok ? String(data?.transcript ?? '').trim() : ''
        if (text) onText(text)
        // Brief 43 PR 17: a too-long recording (413) or a limit (429) says what to do.
        else if (!res.ok) showToast((res.status === 413 || res.status === 429) && typeof data?.message === 'string' ? data.message : 'Couldn’t transcribe that. Try again.')
      } catch {
        showToast('Couldn’t transcribe that. Try again.')
      } finally {
        setState('idle')
      }
    }
    take.current = { stream, recorder }
    recorder.start()
    setState('recording')
    // A pause ends the take, like voice mode (the VAD loads in the background).
    const { MicVAD } = await import('@ricky0123/vad-web')
    MicVAD.new({
      getStream: async () => stream, pauseStream: async () => {}, resumeStream: async () => stream,
      baseAssetPath: VAD_BASE, onnxWASMBasePath: ORT_BASE,
      redemptionMs: VOICE_TIMING.dictationRedemptionMs, onSpeechEnd: stop,
    }).then(vad => {
      if (take.current?.stream === stream) { take.current.vad = vad; vad.start() } else vad.destroy().catch(() => {})
    }).catch(() => { /* tap-to-stop still works */ })
  }

  const recording = state === 'recording'
  return (
    <button
      type="button"
      disabled={disabled || state === 'transcribing'}
      onClick={() => (recording ? stop() : state === 'idle' && start())}
      aria-label={recording ? 'Stop dictation' : 'Dictate a message'}
      aria-pressed={recording}
      style={{
        width: 32, height: 32, borderRadius: '50%', flexShrink: 0, padding: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: recording ? '#fff' : 'rgba(255,255,255,0.08)',
        border: `1px solid ${recording ? '#fff' : 'rgba(255,255,255,0.22)'}`,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled || state === 'transcribing' ? 0.5 : 1,
        transition: 'background 0.15s',
      }}
    >
      {recording ? <Square size={11} fill="#0a1f2a" color="#0a1f2a" /> : <Mic size={15} color="#fff" strokeWidth={1.8} />}
    </button>
  )
}
