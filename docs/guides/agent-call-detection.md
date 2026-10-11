# Checking Agent tool calls

Rialto annotates captured client-facing assistant `tool_use` blocks whose name is exactly
`Agent` or legacy `Task`. This is observation only: no model rewriting, routing,
hooks or tool execution. The live response is untouched.

## Where to check

With **Settings → Logging → Record messages** enabled (`CAPTURE_MESSAGES` not
`false`), open a session's **Conversation** tab to see the existing tool name and
argument preview. The explicit detection metadata is available in the authenticated
session messages API:

```text
GET /api/request-logs/sessions/{sessionId}/messages?limit=100
```

In `items[]` with `role: "assistant"`, look for `content[]` tool blocks carrying
`agent_call` (also persisted in the existing `Message.content` JSON column):

```json
{
  "type": "tool_use",
  "id": "toolu_example",
  "name": "Agent",
  "input": { "prompt": "Inspect tests", "subagent_type": "Explore" },
  "agent_call": {
    "prompt_present": true,
    "subagent_type_present": true,
    "model_present": false
  }
}
```

Follow `nextCursor` with `before` to check older pages. No migration is needed;
existing rows are not backfilled. The Conversation UI shows tool calls but does
not render these metadata flags separately.

## Semantics and privacy

- `Agent` and legacy `Task` calls with a string-valued `prompt` retain their
  **complete input object**, including the full prompt, without the 2,000-character
  preview limit. Other tools and malformed Agent arguments retain that limit.
  Existing truncated records cannot be restored. Detection uses assembled arguments
  before any truncation.
- Each flag means a top-level argument had a string value (including an empty
  string). It is not parameter validation. `model_present: false` is normal for
  an omitted model. Detection metadata duplicates no argument values.
- `REDACT_TOOL_ARGUMENTS=true` replaces input with `[redacted]` but retains the
  name, id and structural flags, including for full-length Agent prompts.
- Each detected call emits an info-level `agent_call_detected` event with
  `sessionId`, `toolUseId`, `toolName` and the three presence flags. Logs do not
  contain prompts or argument values. Events are emitted after response assembly,
  before the archive write, and do not prove that the client executed the call.
- `CAPTURE_MESSAGES=false` disables persistence, including detection metadata,
  but structural call detection logs are still emitted.
  `CAPTURE_REQUESTS` controls request usage rows independently. The parser is
  best-effort and the DB write is asynchronous; wait for response completion and
  archive persistence. A failed read/write can leave no record.

## Supported cases and limits

Both Anthropic-shaped JSON responses and Anthropic SSE content blocks are
supported, including interleaved argument deltas split across transport chunks,
LF/CRLF framing and arguments supplied in the start block. Capture runs on a
client-facing response clone **after response transformers**, so Anthropic clients
using Codex, OpenAI or Gemini upstreams are supported too. The user turn is captured
from the original inbound request before vendor transformations can replace
`messages` with `input`. Non-Anthropic client response formats are not parsed here.
Archive failures emit `message_capture_failed` with the phase and session id,
without including prompt text, arguments or database error details.

A malformed or cut-off argument JSON can still yield a name-based detection,
but its flags are all false: Rialto does not infer fields from partial text.
A missing stop event is finalised best-effort at stream end. Read failures may
lose the whole capture. Detection is not live notification mid-stream.

Text mentions, request-history tool calls, `server_tool_use`, `TaskOutput`,
MCP-qualified names and differently cased names do not match. A match means the
assistant **requested** a tool call; it proves neither client execution nor a
successful subagent launch, the model actually used, nor whether the caller was
a parent or already a subagent. Inspect the relevant parent session to observe
its calls.
