// Brief 43 PR 15 (Q31; Brief 46 drift-2 "Cache the conversation"): one
// prompt-cache breakpoint on the newest tool result in the tool-use loop, so the
// next round reads the history and the earlier results at 0.1× the input price
// instead of paying for them again [engineering precaution].
//
// - Anthropic allows at most 4 breakpoints in a request. The system blocks hold
//   2 (SYSTEM_PROMPT and RYAN_MD, systemBlocks.ts) and the tools none, so the
//   older rounds' marks are taken off and only the newest stays: 3 in all.
// - The round that writes the entry pays 1.25× on the part it adds. The loop's
//   next round (same tools, same tool_choice) reads it. Guard retries, the draft
//   rewrite and the forced final reply use another tool_choice (or tool list),
//   so they can't read the loop's entry; a second retry reads the first's.
import type Anthropic from '@anthropic-ai/sdk'

export function cacheLastToolResult(messages: Anthropic.Messages.MessageParam[]): void {
  let last: Anthropic.Messages.ToolResultBlockParam | null = null
  for (const m of messages) {
    if (m.role !== 'user' || typeof m.content === 'string') continue
    for (const block of m.content) {
      if (block.type !== 'tool_result') continue
      delete block.cache_control
      last = block
    }
  }
  if (last) last.cache_control = { type: 'ephemeral' }
}
