// Brief 36 — Drift's speaking voices, shared by the voice-settings picker
// (client) and /api/tts (server). Provider-neutral on purpose: the provider and
// model live only in lib/voice/tts.ts, so swapping the "mouth" changes that
// module plus, if the new provider's voice ids differ, this list.

export interface VoiceOption {
  id: string
  label: string
  newest?: boolean // listed first as "Newest, most natural"
}

const IDS = ['cedar', 'marin', 'onyx', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'sage', 'shimmer', 'verse']
export const VOICES: readonly VoiceOption[] = IDS.map(id => ({
  id, label: id[0].toUpperCase() + id.slice(1), newest: id === 'cedar' || id === 'marin',
}))

export const DEFAULT_VOICE = 'onyx'

export const SPEEDS = { relaxed: 0.85, normal: 1, brisk: 1.2 } as const
export type SpeedPreset = keyof typeof SPEEDS

export function isVoiceId(v: unknown): v is string {
  return typeof v === 'string' && VOICES.some(o => o.id === v)
}

// Server-side guard for the speed a client asks for (presets are 0.85–1.2).
export function clampSpeed(v: unknown): number {
  return typeof v === 'number' && v >= 0.5 && v <= 2 ? v : SPEEDS.normal
}
