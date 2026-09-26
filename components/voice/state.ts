import { buildReply, type Reply } from './text'

// Brief 36 — voice-mode state machine (pure; unit-tested). The component turns
// device/network callbacks into these events and runs side effects on phase
// changes, so every rule about what may happen when lives here.

export type Phase =
  | 'connecting' | 'listening' | 'hearing' | 'finalizing' | 'thinking' | 'speaking' | 'blocked' | 'closing'
export type BlockReason = 'mic' | 'connect' | 'limit'

// `spoken`: sentences already voiced (dark); the rest stay gray.
export interface Turn { id: number; user: string; reply: Reply | null; interactionId: string | null; spoken: number }

// `live`: the transcript while Ryan talks; `notice`: a one-line gray error above the controls.
export interface VoiceState { phase: Phase; muted: boolean; live: string; turns: Turn[]; notice: string | null; blocked: BlockReason | null }

export type VoiceEvent =
  | { type: 'ready' | 'retry' | 'speechStart' | 'speechEnd' | 'misfire' | 'finalTimeout' | 'doneSpeaking' | 'interrupt' | 'toggleMute' | 'close' }
  | { type: 'blocked'; reason: BlockReason }
  | { type: 'delta' | 'final'; text: string }
  | { type: 'reply'; text: string; interactionId: string | null }
  | { type: 'failed'; message: string }
  | { type: 'spoken'; count: number }

export const initialVoiceState: VoiceState = { phase: 'connecting', muted: false, live: '', turns: [], notice: null, blocked: null }

export const DIDNT_CATCH = 'Didn’t catch that.'

function patchLast(s: VoiceState, patch: (t: Turn) => Partial<Turn>): Turn[] {
  return s.turns.map((t, i) => (i === s.turns.length - 1 ? { ...t, ...patch(t) } : t))
}

export function voiceReducer(s: VoiceState, e: VoiceEvent): VoiceState {
  if (s.phase === 'closing') return s
  switch (e.type) {
    case 'close':
      return { ...s, phase: 'closing' }
    case 'blocked':
      return { ...s, phase: 'blocked', blocked: e.reason, live: '' }
    case 'retry':
      return s.phase === 'blocked' ? { ...s, phase: 'connecting', blocked: null, notice: null } : s
    case 'ready':
      return s.phase === 'connecting' ? { ...s, phase: 'listening' } : s
    case 'toggleMute': {
      // Muting mid-utterance drops it: nothing is transcribed or sent while muted.
      const drop = !s.muted && (s.phase === 'hearing' || s.phase === 'finalizing')
      return { ...s, muted: !s.muted, ...(drop ? { phase: 'listening', live: '' } : {}) }
    }
    case 'speechStart':
      return s.phase === 'listening' && !s.muted ? { ...s, phase: 'hearing', notice: null } : s
    case 'delta':
      return (s.phase === 'hearing' || s.phase === 'finalizing') && !s.muted ? { ...s, live: s.live + e.text } : s
    case 'speechEnd':
      return s.phase === 'hearing' ? { ...s, phase: 'finalizing' } : s
    case 'misfire':
      return s.phase === 'hearing' ? { ...s, phase: 'listening', live: '' } : s
    case 'final': {
      if (s.phase !== 'finalizing') return s
      const user = e.text.trim()
      if (!user) return { ...s, phase: 'listening', live: '' }
      const turn: Turn = { id: s.turns.length, user, reply: null, interactionId: null, spoken: 0 }
      return { ...s, phase: 'thinking', live: '', turns: [...s.turns, turn] }
    }
    case 'finalTimeout':
      return s.phase === 'finalizing' ? { ...s, phase: 'listening', live: '', notice: DIDNT_CATCH } : s
    case 'reply':
      if (s.phase !== 'thinking') return s
      return { ...s, phase: 'speaking', turns: patchLast(s, () => ({ reply: buildReply(e.text), interactionId: e.interactionId })) }
    case 'failed':
      return s.phase === 'thinking' || s.phase === 'speaking' ? { ...s, phase: 'listening', notice: e.message } : s
    case 'spoken':
      return s.phase === 'speaking' ? { ...s, turns: patchLast(s, t => ({ spoken: Math.max(t.spoken, e.count) })) } : s
    case 'doneSpeaking':
      if (s.phase !== 'speaking') return s
      return { ...s, phase: 'listening', turns: patchLast(s, t => ({ spoken: t.reply?.sentences.length ?? 0 })) }
    case 'interrupt':
      // Stop mid-reply: unspoken sentences stay gray, listening resumes.
      return s.phase === 'speaking' ? { ...s, phase: 'listening' } : s
  }
}
