'use client'

import { useState } from 'react'
import type { Draft } from '@/lib/chat/draft'
import { draftHeading, draftCopyText, DRAFT_NOTE, COPY_FAILED } from './draftCardText'

// Brief 43 PR 3 (Q3): a Drift draft as a block Ryan can copy, under the reply
// that came with it. Copying is Ryan's action; nothing here sends anything
// [Ryan, 2026-09-24]. The draft was checked for homeowner details before it got
// here (lib/chat/guards/draftPrivacy.ts).
export default function DraftCard({ draft }: { draft: Draft }) {
  const [copied, setCopied] = useState<'body' | 'subject' | 'failed' | null>(null)

  async function copy(part: 'body' | 'subject') {
    try {
      await navigator.clipboard.writeText(draftCopyText(draft, part))
      setCopied(part)
    } catch {
      setCopied('failed')
    }
  }

  const pill: React.CSSProperties = {
    background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.18)',
    color: '#fff', borderRadius: 999, padding: '7px 13px',
    fontFamily: 'var(--font-ui)', fontSize: 11.5, fontWeight: 300, cursor: 'pointer',
  }

  return (
    <div
      data-testid="draft-card"
      role="group"
      aria-label={draftHeading(draft)}
      style={{ marginTop: 10, marginLeft: 4, paddingLeft: 12, borderLeft: '2px solid rgba(255,255,255,0.12)' }}
    >
      <div style={{
        fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.14em',
        color: 'var(--sr-cream, #EAB308)', textTransform: 'uppercase', marginBottom: 6,
      }}>
        {draftHeading(draft)}
      </div>

      {draft.channel === 'email' && draft.subject && (
        <div data-testid="draft-subject" style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 400, color: 'rgba(255,255,255,0.92)', marginBottom: 6 }}>
          Subject: {draft.subject}
        </div>
      )}

      <div data-testid="draft-body" style={{
        fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 300, lineHeight: 1.5,
        color: 'rgba(255,255,255,0.85)', whiteSpace: 'pre-wrap', userSelect: 'text',
        background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '10px 12px',
      }}>
        {draft.body}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <button type="button" onClick={() => copy('body')} style={pill}>
          {copied === 'body' ? 'Copied' : 'Copy'}
        </button>
        {draft.channel === 'email' && draft.subject && (
          <button type="button" onClick={() => copy('subject')} style={pill}>
            {copied === 'subject' ? 'Copied' : 'Copy subject'}
          </button>
        )}
      </div>

      <div style={{ marginTop: 6, fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 300, color: 'rgba(255,255,255,0.45)' }}>
        {copied === 'failed' ? COPY_FAILED : DRAFT_NOTE}
      </div>
    </div>
  )
}
