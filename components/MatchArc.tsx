interface Props {
  pct: number        // 0–100
  size?: number      // diameter px, default 44
  strokeWidth?: number
  color?: string
  showLabel?: boolean
}

export default function MatchArc({
  pct,
  size = 44,
  strokeWidth = 2.5,
  color = '#ffffff',
  showLabel = true,
}: Props) {
  const clamped  = Math.min(100, Math.max(0, pct))
  const r        = (size - strokeWidth) / 2
  const circ     = 2 * Math.PI * r
  const offset   = circ * (1 - clamped / 100)
  const cx = size / 2
  const cy = size / 2

  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg
        width={size}
        height={size}
        style={{ transform: 'rotate(-90deg)', display: 'block' }}
        aria-label={`Match score ${Math.round(clamped)}%`}
      >
        {/* Track */}
        <circle
          cx={cx} cy={cy} r={r}
          fill="none"
          stroke="rgba(255,255,255,0.12)"
          strokeWidth={strokeWidth}
        />
        {/* Arc */}
        <circle
          cx={cx} cy={cy} r={r}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={circ}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.4s var(--sr-spring)' }}
        />
      </svg>

      {showLabel && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--font-display)',
          fontSize: size < 40 ? 10 : 13,
          fontWeight: 400,
          color: 'rgba(255,255,255,0.92)',
          lineHeight: 1,
        }}>
          {Math.round(clamped)}
        </div>
      )}
    </div>
  )
}
