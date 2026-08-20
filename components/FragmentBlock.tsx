'use client'

import type { AttachedFragment } from '@/lib/reports/uiTypes'
import { SectionItems, SectionMetrics, SourceChips } from './_reportSection'

// Brief 28.0 — inline fragment rendering. NOT a card: a small-caps section label
// then the structured content baked into the chat message, so it reads as part of
// Jarvis's reply. Rendered whenever a message carries attachedFragment.

export default function FragmentBlock({ fragment }: { fragment: AttachedFragment }) {
  const { title, content, sources } = fragment
  return (
    <div style={{ marginTop: 10, marginLeft: 4, paddingLeft: 12, borderLeft: '2px solid rgba(255,255,255,0.12)' }}>
      <div style={{
        fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.14em',
        color: 'var(--sr-cream, #EAB308)', textTransform: 'uppercase', marginBottom: 6,
      }}>
        {title}
      </div>

      {content.prose && (
        <p style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 300, lineHeight: 1.5, color: 'rgba(255,255,255,0.85)', margin: 0 }}>
          {content.prose}
        </p>
      )}

      {content.items && content.items.length > 0 && <SectionItems items={content.items} />}
      {content.metrics && content.metrics.length > 0 && <SectionMetrics metrics={content.metrics} />}

      <SourceChips sources={sources} />
    </div>
  )
}
