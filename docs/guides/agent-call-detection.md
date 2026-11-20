# Checking Agent tool calls

Rialto observes client-facing Anthropic `tool_use` blocks named `Agent` or legacy
`Task`. Each detected call emits an info-level `agent_call_detected` log event
with the session ID, tool name, tool-use ID, and flags indicating whether
`prompt`, `subagent_type`, and `model` were supplied as strings.

Open **Activity → Logs** to find these events when server logging is enabled.
The events describe what the assistant requested. Use the client to confirm
whether the tool was executed or whether a subagent was launched. The logs
contain the presence flags rather than the argument values.

## Session storage

With request capture enabled, Rialto stores request metadata and a bounded
plain-text copy of the first identifiable user input for each session. This
is the source of the preview in Sessions. Subsequent user turns, assistant
responses, and tool arguments are excluded from new session storage.

Historical message rows remain available to the existing authenticated
messages API and the storage-retention controls. The optional
`CAPTURE_FULL_REQUESTS` diagnostic archive is configured separately.

## Supported responses

Detection supports Anthropic-shaped JSON and SSE tool blocks after response
transformation. That includes Anthropic clients routed to Codex, OpenAI, or
Gemini. Argument fragments are assembled before checking for string values.
Incomplete or malformed arguments can produce a name-based detection with
all presence flags set to false.
