// Brief 41.1: what a log line may say about a model's tool output: its shape
// (keys, value types, array and string lengths), never its text. The text can
// carry a seller's personal circumstances (estate, probate, divorce, a death,
// illness) or a person's name. Pure, so it's tested without the SDK.
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const MAX_DEPTH = 4

export function toolInputShape(value: unknown, depth = 0): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    const first = value.length && depth < MAX_DEPTH ? `[${toolInputShape(value[0], depth + 1)}]` : ''
    return `array(${value.length})${first}`
  }
  if (typeof value === 'string') return `string(${value.length})`
  if (typeof value !== 'object') return typeof value
  if (depth >= MAX_DEPTH) return 'object'
  // A key that isn't a plain field name is model text too: not shown.
  const fields = Object.entries(value as Record<string, unknown>).map(
    ([k, v]) => `${PLAIN_KEY.test(k) ? k : '?'}: ${toolInputShape(v, depth + 1)}`,
  )
  return `{${fields.join(', ')}}`
}
