// Brief 29.0 — assembly of the chat turn's Anthropic system blocks.
//
// Extracted from app/api/chat/route.ts so the block layout is unit-testable
// (the route handler itself is not). Layout:
//   [0] SYSTEM_PROMPT   — static, cached (ephemeral)
//   [1] RYAN_MD         — static personal glossary, cached (ephemeral)  ← Brief 29.0
//   [2] dynamicSystemBlock (optional) — per-turn side-channels, NOT cached
//
// RYAN_MD is imported via a RELATIVE path (not the @/ alias) so ts-node test
// runners resolve it — the @/ alias is a Next-only convenience.
import type Anthropic from '@anthropic-ai/sdk'
import { RYAN_MD } from '../prompts/ryanMd'

export { RYAN_MD }

export function buildSystemBlocks(
  systemPrompt: string,
  dynamicSystemBlock: string,
): Anthropic.Messages.TextBlockParam[] {
  const blocks: Anthropic.Messages.TextBlockParam[] = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: RYAN_MD, cache_control: { type: 'ephemeral' } },
  ]
  if (dynamicSystemBlock) blocks.push({ type: 'text', text: dynamicSystemBlock })
  return blocks
}
