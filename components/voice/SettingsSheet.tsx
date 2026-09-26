'use client'

import { Check, Play } from 'lucide-react'
import { DEFAULT_VOICE, SPEEDS, VOICES, type SpeedPreset } from '@/lib/voice/voices'
import type { VoiceSettings } from './settings'
import styles from './voice.module.css'

const SPEED_LABELS: Record<SpeedPreset, string> = { relaxed: 'Relaxed', normal: 'Normal', brisk: 'Brisk' }
const GROUPS = [
  ['Newest, most natural', VOICES.filter(v => v.newest)],
  ['More voices', VOICES.filter(v => !v.newest)],
] as const

// Brief 36 PR B — voice-mode settings: Drift's voice (each with a spoken
// preview) and a speed preset. Changes save as they're made.
export default function SettingsSheet({ settings, onChange, onPreview, onClose }: {
  settings: VoiceSettings
  onChange: (s: VoiceSettings) => void
  onPreview: (voice: string) => void
  onClose: () => void
}) {
  return (
    <div className={styles.sheetBackdrop} onClick={onClose}>
      <div className={styles.sheet} role="dialog" aria-label="Voice settings" onClick={e => e.stopPropagation()}>
        <div className={styles.grabber} />
        {GROUPS.map(([title, voices]) => (
          <section key={title}>
            <h3 className={styles.sheetLabel}>{title}</h3>
            {voices.map(v => (
              <div key={v.id} className={styles.voiceRow}>
                <button className={styles.voicePick} aria-pressed={settings.voice === v.id} onClick={() => onChange({ ...settings, voice: v.id })}>
                  {v.label}{v.id === DEFAULT_VOICE && <span className={styles.hint}> · Default</span>}
                  {settings.voice === v.id && <Check size={18} strokeWidth={2} />}
                </button>
                <button className={styles.preview} aria-label={`Hear ${v.label}`} onClick={() => onPreview(v.id)}>
                  <Play size={13} strokeWidth={2} fill="currentColor" />
                </button>
              </div>
            ))}
          </section>
        ))}
        <h3 className={styles.sheetLabel}>Speed</h3>
        <div className={styles.speeds} role="radiogroup" aria-label="Speaking speed">
          {(Object.keys(SPEEDS) as SpeedPreset[]).map(k => (
            <button key={k} role="radio" aria-checked={settings.speed === k} onClick={() => onChange({ ...settings, speed: k })}>
              {SPEED_LABELS[k]}
            </button>
          ))}
        </div>
        <button className={styles.done} onClick={onClose}>Done</button>
      </div>
    </div>
  )
}
