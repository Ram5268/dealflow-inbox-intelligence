'use client'

import { useEffect, useRef } from 'react'
import styles from './voice.module.css'

export type GlowTone = 'blue' | 'coral' | 'thinking'

// Brief 36 — the bottom glow: blurred ellipses that breathe (CSS) and swell and
// sway with the audio level (rAF, lerped ~0.15/frame, written straight to the
// DOM so nothing re-renders per frame). Blue while listening, coral while Drift
// speaks; `thinking` breathes faster and leans coral.
export default function Glow({ tone, dim, getLevel }: { tone: GlowTone; dim: boolean; getLevel: () => number }) {
  const layer = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let raf = 0
    let level = 0
    const frame = (t: number) => {
      level += (getLevel() - level) * 0.15
      if (layer.current) {
        // Height 0.9–1.25x with the level; drift up to ±6% while there's sound.
        layer.current.style.transform = `translateX(${Math.sin(t / 1400) * 6 * level}%) scaleY(${0.9 + 0.35 * level})`
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [getLevel])

  return (
    <div className={styles.glow} data-tone={tone} data-dim={dim} aria-hidden>
      <div className={styles.breathe}>
        <div ref={layer} className={styles.level}>
          <div className={styles.blue} />
          <div className={styles.coral} />
        </div>
      </div>
    </div>
  )
}
