'use client'

interface Props {
  onOpenVoice: () => void
  disabled?: boolean
}

export default function MicButton({ onOpenVoice, disabled }: Props) {
  const open = () => { if (!disabled) onOpenVoice() }

  return (
    <button
      type="button"
      disabled={disabled}
      onMouseDown={open}
      onTouchStart={e => { e.preventDefault(); open() }}
      onContextMenu={e => e.preventDefault()}
      aria-label="Open voice conversation"
      style={{
        width: 32, height: 32, borderRadius: '50%',
        background: 'rgba(255,255,255,0.08)',
        border: '1px solid rgba(255,255,255,0.22)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: disabled ? 'default' : 'pointer',
        padding: 0,
        opacity: disabled ? 0.5 : 1,
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
      }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round">
        <rect x="9" y="3" width="6" height="12" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </svg>
    </button>
  )
}
