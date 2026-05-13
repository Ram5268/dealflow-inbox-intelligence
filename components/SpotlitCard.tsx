interface Props {
  ask: string
  summary: string
  onOpen: () => void
  children?: React.ReactNode
}

// Glass card with a static conic-gradient highlight at 200°.
// The conic sweep is decorative — signals "this is the active answer."
export default function SpotlitCard({ ask, summary, onOpen, children }: Props) {
  return (
    <div style={{
      position: 'relative',
      overflow: 'hidden',
      background: 'rgba(255,255,255,0.12)',
      border: '1px solid rgba(255,255,255,0.14)',
      backdropFilter: 'blur(28px) saturate(170%)',
      WebkitBackdropFilter: 'blur(28px) saturate(170%)',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 16px 30px rgba(0,0,0,0.35)',
      borderRadius: 20,
      padding: '18px 20px',
    }}>
      {/* Conic spotlight — static, 60°→140° sweep from 200° origin */}
      <div
        aria-hidden
        style={{
          position: 'absolute', inset: 0,
          borderRadius: 20,
          pointerEvents: 'none',
          background: 'conic-gradient(from 200deg at 72% 28%, transparent 0deg, rgba(255,255,255,0.04) 60deg, rgba(255,255,255,0.10) 100deg, rgba(255,255,255,0.04) 140deg, transparent 180deg)',
        }}
      />

      <div style={{ position: 'relative' }}>
        {/* Italic ask */}
        <p style={{
          fontFamily: 'var(--font-display)',
          fontSize: 13,
          fontStyle: 'italic',
          fontWeight: 300,
          color: 'rgba(255,255,255,0.55)',
          lineHeight: 1.5,
          marginBottom: 8,
        }}>
          "{ask}"
        </p>

        {/* AI summary */}
        <p style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 13,
          fontWeight: 300,
          color: 'rgba(255,255,255,0.82)',
          lineHeight: 1.55,
          marginBottom: children ? 12 : 14,
        }}>
          {summary}
        </p>

        {children}

        {/* Open → */}
        <button
          onClick={onOpen}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            fontFamily: 'var(--font-ui)',
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--sr-cream)',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            marginTop: 4,
          }}
        >
          Open <span aria-hidden>→</span>
        </button>
      </div>
    </div>
  )
}
