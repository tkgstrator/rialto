// Model-family guard for reasoning-effort support. Matches gpt-5.x,
// gpt-6.x and o-series chat models that accept `max_completion_tokens`
// and `reasoning_effort` on Chat Completions.
// Older gpt-4.x models silently ignore both fields. Kept in its own
// file (no node imports) so the Tier editor can pull it into the
// browser bundle without dragging shared/constants' os.homedir() call
// into client-side JS.
export const REASONING_MODEL_RE = /^(gpt-[56](?:\.\d+)?(?:-|$)|o[1-9](?:-|$))/
