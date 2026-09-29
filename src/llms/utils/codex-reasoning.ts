/**
 * A Codex reasoning item, carried through a client's transcript inside a
 * thinking signature so that the next turn can hand it back.
 *
 * The Codex CLI sends `store: false` with `include:
 * ['reasoning.encrypted_content']`, and replays every reasoning item it got
 * back, whole and ahead of the output it preceded, on each later turn
 * (measured against 0.158.0). A Rialto client keeps no reasoning items —
 * Claude Code keeps thinking blocks — so the item rides in the block's
 * signature and becomes an item again on the way out.
 *
 * Sealed in with the encrypted content:
 *   - the provider that answered. Only a request to that same provider runs
 *     the codex-oauth step that can vouch for the item; an API-key
 *     Responses upstream would 400 on a blob it cannot decrypt.
 *   - a tag for the subscription account. The blob is encrypted for the
 *     account that produced it, and account rotation can move the next
 *     turn to a different one.
 *   - the item id, which the CLI replays alongside it.
 *
 * The prefix begins with `rialto_`, so claude-code-oauth's keepSignedBlock
 * drops a sealed item like any other signature Anthropic cannot validate.
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'

const PREFIX = 'rialto_codex.'

const SealedHeaderSchema = z.object({
  provider: z.string().nonempty(),
  account: z.string().nonempty(),
  id: z.string().nonempty().optional()
})

export type CodexReasoning = z.infer<typeof SealedHeaderSchema> & { encryptedContent: string }

/** Seals one reasoning item for the given provider and account tag. */
export type ReasoningSealer = (id: string | undefined, encryptedContent: string) => string

/**
 * An opaque, stable stand-in for a subscription account. The raw id would
 * work as well, but it is Rialto's internal key and has no business sitting
 * in a client's transcript.
 */
export function codexAccountTag(subAccountId: string): string {
  return createHash('sha256').update(`codex-account:${subAccountId}`).digest('hex').slice(0, 16)
}

export function sealCodexReasoning(reasoning: CodexReasoning): string {
  const header: z.infer<typeof SealedHeaderSchema> = { provider: reasoning.provider, account: reasoning.account }
  if (reasoning.id !== undefined) header.id = reasoning.id
  // The encrypted content goes last and unencoded: it is already
  // URL-safe base64 and by far the longest part, and the header — which is
  // base64url, so it holds no '.' — ends at the first dot after the prefix.
  return `${PREFIX}${Buffer.from(JSON.stringify(header)).toString('base64url')}.${reasoning.encryptedContent}`
}

export function isSealedCodexReasoning(signature: string): boolean {
  return signature.startsWith(PREFIX)
}

export function openCodexReasoning(signature: string): CodexReasoning | null {
  if (!isSealedCodexReasoning(signature)) return null
  const rest = signature.slice(PREFIX.length)
  const dot = rest.indexOf('.')
  if (dot <= 0 || dot === rest.length - 1) return null
  try {
    const header = SealedHeaderSchema.safeParse(JSON.parse(Buffer.from(rest.slice(0, dot), 'base64url').toString()))
    return header.success ? { ...header.data, encryptedContent: rest.slice(dot + 1) } : null
  } catch {
    return null
  }
}
