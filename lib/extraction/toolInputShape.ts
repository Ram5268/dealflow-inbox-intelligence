// Brief 41.1: what a log line may say about a model's tool output: its shape
// (keys, value types, array and string lengths), never its text. The text can
// carry a seller's personal circumstances (estate, probate, divorce, a death,
// illness) or a person's name. Only the keys the tool's JSON schema defines are
// named; any other key is the model's own text, so it shows as "?". Pure, so
// it's tested without the SDK.
const MAX_DEPTH = 4

type SchemaNode = { properties?: unknown; items?: unknown }
const asNode = (s: unknown): SchemaNode => (s && typeof s === 'object' ? (s as SchemaNode) : {})

export function toolInputShape(value: unknown, schema?: unknown, depth = 0): string {
  const node = asNode(schema)
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    const first = value.length && depth < MAX_DEPTH ? `[${toolInputShape(value[0], node.items, depth + 1)}]` : ''
    return `array(${value.length})${first}`
  }
  if (typeof value === 'string') return `string(${value.length})`
  if (typeof value !== 'object') return typeof value
  if (depth >= MAX_DEPTH) return 'object'
  const known = node.properties && typeof node.properties === 'object' ? (node.properties as Record<string, unknown>) : {}
  const fields = Object.entries(value as Record<string, unknown>).map(([k, v]) =>
    Object.hasOwn(known, k) ? `${k}: ${toolInputShape(v, known[k], depth + 1)}` : `?: ${toolInputShape(v, undefined, depth + 1)}`,
  )
  return `{${fields.join(', ')}}`
}
