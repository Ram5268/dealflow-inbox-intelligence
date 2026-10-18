// A stand-in for fetch, for tests that run the real OpenAI / Anthropic code
// paths without the network. It answers only those two APIs, with the reply the
// test sets, records every request, and refuses any other address. Both SDKs
// take the global fetch when a client is created, so install this before any
// client is made. The keys are test-only placeholders: the SDKs refuse to start
// without one, and nothing ever leaves this process.
export type AiRequest = { url: string; body: Record<string, unknown> }

export function installFakeAiFetch() {
  const requests: AiRequest[] = []
  let answer: ((req: AiRequest) => unknown) | null = null
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url: string }).url
    if (!/^https:\/\/api\.(openai|anthropic)\.com\//.test(url)) throw new Error(`test: unexpected network call to ${url}`)
    const req: AiRequest = { url, body: JSON.parse(String(init?.body ?? '{}')) }
    requests.push(req)
    if (!answer) throw new Error('test: no AI reply set')
    return new Response(JSON.stringify(answer(req)), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  process.env.OPENAI_API_KEY = 'test-only-placeholder'
  process.env.ANTHROPIC_API_KEY = 'test-only-placeholder'
  return {
    requests,
    reply(fn: (req: AiRequest) => unknown) { answer = fn },
  }
}

// An OpenAI chat completion whose message is `content` as JSON.
export const openAiChat = (content: unknown) => ({
  id: 'chatcmpl-test', object: 'chat.completion', created: 0, model: 'gpt-4o-mini',
  choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: JSON.stringify(content), refusal: null } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
})

const anthropicMessage = (content: unknown[], stop: string) => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-test', content,
  stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
})
// An Anthropic message with one text block.
export const anthropicText = (text: string) => anthropicMessage([{ type: 'text', text }], 'end_turn')
// An Anthropic message calling the tool `name` with `input`.
export const anthropicTool = (name: string, input: unknown) =>
  anthropicMessage([{ type: 'tool_use', id: 'toolu_test', name, input }], 'tool_use')

// The system prompt of a recorded request (OpenAI: the first message;
// Anthropic: the system field, a string or text blocks).
export function systemPromptOf(req: AiRequest): string {
  const { system, messages } = req.body as { system?: unknown; messages?: Array<{ role: string; content: unknown }> }
  if (typeof system === 'string') return system
  if (Array.isArray(system)) return system.map(b => (b as { text?: string }).text ?? '').join('\n')
  const first = messages?.find(m => m.role === 'system')
  return typeof first?.content === 'string' ? first.content : ''
}
