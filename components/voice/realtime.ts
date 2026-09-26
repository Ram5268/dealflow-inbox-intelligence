// Brief 36 — live transcription link: mic track → WebRTC → transcription
// service. The SDP handshake goes through /api/voice/session, which adds the
// session config and credentials server-side. Open it only after
// getUserMedia succeeds: Safari hides ICE host candidates until the page has
// mic permission, and without them the connection never opens.

// commit(): end of Ryan's turn → a final transcript follows. clear(): drop
// buffered audio (after a misfire, a mute or Drift's turn).
export interface TranscriptLink { commit(): void; clear(): void; close(): void }
interface Handlers { delta(text: string): void; final(text: string): void; lost(): void }

export class VoiceSessionError extends Error {
  constructor(readonly status: number) { super(`voice session ${status}`) }
}

export async function openTranscriptLink(stream: MediaStream, on: Handlers): Promise<TranscriptLink> {
  const pc = new RTCPeerConnection()
  pc.addTrack(stream.getAudioTracks()[0], stream)
  const dc = pc.createDataChannel('oai-events')
  dc.onmessage = e => {
    const ev = JSON.parse(e.data)
    if (ev.type === 'conversation.item.input_audio_transcription.delta') on.delta(ev.delta ?? '')
    else if (ev.type === 'conversation.item.input_audio_transcription.completed') on.final(ev.transcript ?? '')
    else if (ev.type === 'error') console.warn('[voice] transcription error', ev.error)
  }
  try {
    await pc.setLocalDescription(await pc.createOffer())
    const res = await fetch('/api/voice/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription?.sdp,
    })
    if (!res.ok) throw new VoiceSessionError(res.status)
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() })
    await new Promise<void>((resolve, reject) => {
      dc.onopen = () => resolve()
      setTimeout(() => reject(new Error('voice link timeout')), 10_000)
    })
  } catch (err) {
    pc.close()
    throw err
  }
  let closed = false
  pc.onconnectionstatechange = () => {
    if (!closed && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) on.lost()
  }
  const send = (type: string) => { if (dc.readyState === 'open') dc.send(JSON.stringify({ type })) }
  return {
    commit: () => send('input_audio_buffer.commit'),
    clear: () => send('input_audio_buffer.clear'),
    close: () => { closed = true; dc.close(); pc.close() },
  }
}
