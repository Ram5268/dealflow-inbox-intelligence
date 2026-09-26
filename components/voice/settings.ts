import { DEFAULT_VOICE, SPEEDS, isVoiceId, type SpeedPreset } from '../../lib/voice/voices'

// Brief 36 PR B — voice-mode settings (voice + speed preset), kept in
// localStorage. Unknown or corrupt values fall back to the defaults.
export interface VoiceSettings {
  voice: string
  speed: SpeedPreset
}

export const DEFAULT_SETTINGS: VoiceSettings = { voice: DEFAULT_VOICE, speed: 'normal' }
const KEY = 'dealflow.voiceSettings'

export function readSettings(store?: Pick<Storage, 'getItem'>): VoiceSettings {
  try {
    const raw = JSON.parse(store?.getItem(KEY) ?? 'null')
    return {
      voice: isVoiceId(raw?.voice) ? raw.voice : DEFAULT_SETTINGS.voice,
      speed: Object.keys(SPEEDS).includes(raw?.speed) ? raw.speed : DEFAULT_SETTINGS.speed,
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function writeSettings(store: Pick<Storage, 'setItem'> | undefined, s: VoiceSettings) {
  try { store?.setItem(KEY, JSON.stringify(s)) } catch { /* storage blocked (private mode) */ }
}
