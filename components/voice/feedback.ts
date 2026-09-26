// Brief 36 PR B — voice-mode thumbs reuse the chat's existing feedback sink
// (/api/chat/interaction → DriftInteractionFeedback); no new route.
export type Thumb = 'up' | 'down'

export const THUMB_VOTE = { up: 'helpful', down: 'wrong_result' } as const

export function feedbackBody(interactionId: string, thumb: Thumb) {
  return { interactionId, event: 'feedback' as const, vote: THUMB_VOTE[thumb] }
}

export function sendThumb(interactionId: string, thumb: Thumb) {
  fetch('/api/chat/interaction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(feedbackBody(interactionId, thumb)),
  }).catch(() => {})
}
