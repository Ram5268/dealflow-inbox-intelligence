import type { VoiceEvent } from './state'

// Brief 36 — dev-only visual-parity demo: /chat?voiceDemo=1 plays the loop,
// &state=01…04 freezes on a reference state. Canned text (the reference
// screens' own, so line breaks can be compared) and a fake audio level.
// Never loaded in production builds.

export const DEMO_USER = 'Give me a two day healthy meal plan.'
export const DEMO_REPLY = [
  'Sure! Here’s a straightforward two day plan for you.',
  'Day One: Start with oatmeal and berries for breakfast, a grilled chicken salad with lots of veggies for lunch, and baked salmon with roasted broccoli and sweet potato for dinner.',
  'Day Two: Have scrambled eggs with whole grain toast and avocado for breakfast, a turkey and veggie wrap with hummus for lunch, and lean ground turkey tacos with brown rice and black beans for dinner.',
  'The idea is keeping things balanced with protein, whole grains, and plenty of vegetables at each meal. Want me to adjust anything or dive deeper into recipes?',
].join('\n\n')

const hear: VoiceEvent[] = [{ type: 'ready' }, { type: 'speechStart' }, { type: 'delta', text: DEMO_USER }]
const answer: VoiceEvent[] = [
  ...hear,
  { type: 'speechEnd' },
  { type: 'final', text: DEMO_USER },
  { type: 'reply', text: DEMO_REPLY, interactionId: 'demo' },
]

export const DEMO_STATES: Record<string, VoiceEvent[]> = {
  '01': [{ type: 'ready' }],
  '02': hear,
  '03': [...answer, { type: 'spoken', count: 2 }],
  '04': [...answer, { type: 'doneSpeaking' }],
}

// The whole loop as [ms offset, event] pairs.
export function demoTimeline(): Array<[number, VoiceEvent]> {
  const out: Array<[number, VoiceEvent]> = [[0, { type: 'ready' }], [1600, { type: 'speechStart' }]]
  let t = 1700
  DEMO_USER.split(' ').forEach((w, i) => out.push([(t += 220), { type: 'delta', text: (i ? ' ' : '') + w }]))
  out.push([(t += 900), { type: 'speechEnd' }], [(t += 500), { type: 'final', text: DEMO_USER }])
  out.push([(t += 1400), { type: 'reply', text: DEMO_REPLY, interactionId: 'demo' }])
  for (let n = 1; n <= 6; n++) out.push([(t += 1600), { type: 'spoken', count: n }])
  out.push([(t += 1600), { type: 'doneSpeaking' }])
  return out
}

export const demoLevel = (t: number) => 0.32 + 0.22 * Math.sin(t / 170) * Math.sin(t / 530)
