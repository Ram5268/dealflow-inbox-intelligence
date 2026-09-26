// Brief 35: the morning digest's tier counts. Each match counts exactly once, by
// Match.tier; legacy rows with no tier fall back to score bands (80 / 65).
export function tierCounts(matches: Array<{ tier: string | null; score: number }>) {
  const counts = { hot: 0, warm: 0, possible: 0 }
  for (const m of matches) {
    const tier = m.tier ?? (m.score >= 80 ? 'HOT' : m.score >= 65 ? 'WARM' : 'POSSIBLE')
    counts[tier === 'HOT' ? 'hot' : tier === 'WARM' ? 'warm' : 'possible']++
  }
  return counts
}
