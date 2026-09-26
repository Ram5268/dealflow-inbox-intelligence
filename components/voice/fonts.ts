import { Inter, Source_Serif_4 } from 'next/font/google'

// Brief 36 — voice-mode type, scoped to the overlay. Source Serif 4 (optical
// sizing on) reproduced the reference reply's line breaks and ink height at
// ~17px in Phase 0; Inter italic carries the live transcript.
export const voiceSerif = Source_Serif_4({ subsets: ['latin'], axes: ['opsz'], variable: '--voice-serif', display: 'swap' })
export const voiceItalic = Inter({ subsets: ['latin'], style: ['italic'], weight: ['400'], variable: '--voice-italic', display: 'swap' })
