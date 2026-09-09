# Inbound Parity Matrix (surface × feature)

## Purpose

Rialto serves four entry points ([inbound surfaces](./inbound-surfaces.md)) through one pipeline.
Adding a descriptor adds a surface, but **how much of that surface actually works** is decided
outside the descriptor — in the conversion layer. This document puts that reality into a
surface × feature table, giving every cell a label (supported / partial / unsupported) and the
path of the test that backs it.

**This table exists so that a blank cell cannot be dropped in silence.** An unsupported cell
always carries a reason and names the code that makes it behave that way.

## Judging criteria — only the conversion path counts

The pipeline has two paths.

- **Bypass path** — when the surface's wire format matches the provider's
  (`/v1/messages` → Anthropic, `/v1beta/models/*` → Google, and so on).
  `shouldBypass` (`src/llms/pipeline/request-chain.ts`) holds and not one conversion hook runs.
  The body passes through untouched, so **every feature works automatically**.
- **Conversion path** — when the surface and the provider disagree on wire format.
  The surface's endpoint transformer lowers the request into the internal representation
  (OpenAI chat.completion) in `transformRequestOut` and lifts it back into the surface's
  vocabulary in `transformResponseIn`. Anything that representation cannot express
  **disappears silently**.

**What this table evaluates is the conversion path.** Mixing the bypass path in would mark every
cell supported and the table would say nothing. The conversion path is also the one that only
opens when a surface's `routingMode` is set to `routed` — that is, the path you take the moment
you use routing at all.

## Matrix

Legend: `Supported` = works on the conversion path / `Partial` = works only in some directions or
on some paths / `Unsupported` = does not work. A number in parentheses points at the matching
cell note below.

| | messages | chat/completions | responses | gemini |
|---|---|---|---|---|
| streaming (SSE) | Supported | Supported | Partial (1) | Supported |
| non-streaming aggregation | Supported | Supported | Supported | Supported |
| tool use | Supported | Supported | Supported | Supported (2) |
| system prompt | Supported | Supported | Supported | Supported (3) |
| image input | Supported | Supported | Supported | Supported (4) |
| thinking / reasoning | Supported (5) | Partial (6) | Partial (7) | Supported (8) |
| usage record (RequestLog) | Supported | Supported | Supported | Supported (9) |
| error shape | Supported | Supported | Supported | Supported |
| cache token accounting | Supported | Supported (10) | Partial (11) | Supported (12) |
| failover / 429 | Supported | Supported | Supported | Supported |

## Backing tests per row

| Row | Tests that back it |
|---|---|
| streaming (SSE) | `__tests__/parity/streaming.test.ts` |
| non-streaming aggregation | `__tests__/parity/non-stream-aggregate.test.ts`, `__tests__/llms/sse-aggregate.test.ts` |
| tool use | `__tests__/parity/tool-use.test.ts`, `__tests__/llms/transformers/anthropic-request.test.ts`, `__tests__/llms/openai-responses-inbound.test.ts`, `__tests__/llms/gemini-inbound-response.test.ts` |
| system prompt | `__tests__/parity/system-prompt.test.ts`, `__tests__/llms/openai-transformer-request-out.test.ts` |
| image input | `__tests__/parity/image-input.test.ts` |
| thinking / reasoning | `__tests__/parity/thinking.test.ts` |
| usage record (RequestLog) | `__tests__/parity/usage-record.test.ts` |
| error shape | `__tests__/parity/error-envelope.test.ts`, `__tests__/api/error-shape.test.ts` |
| cache token accounting | `__tests__/parity/cache-tokens.test.ts` |
| failover / 429 | `__tests__/parity/failover-429.test.ts`, `__tests__/parity/routing-mode.test.ts` |

The surfaces themselves — descriptors, path resolution, aggregator assignment — are backed by
`__tests__/llms/inbound-surfaces.test.ts` and `__tests__/api/route-plan.test.ts`. That the gaps in
the gemini column all reduced to one cause (a broken `contents[]` conversion), and the full shape
of `contents[]` after that fix, are pinned by
`__tests__/parity/gemini-request-conversion.test.ts`.

## Cell notes

### (1) responses × streaming — loses its incrementality

`OpenAIResponsesTransformer.transformResponseIn` (`src/llms/transformers/openai/endpoint-responses.ts`)
**folds the upstream chat SSE into JSON first**, with `aggregateOpenAiChatSseToJson`, and then
composes fresh Responses SSE. The event sequence comes out in the same order as the real thing, so
the wire contract holds — but the first `output_text.delta` only appears after the upstream
finishes, which means TTFT is gone. Passing the Chat → Responses boundary incrementally needs a
different implementation.

### (2) gemini × tool use — **fixed** (2026-09-01)

`tools[].functionDeclarations` always came through. What was lost were the `functionCall` (the
assistant's call) and `functionResponse` (the tool's return value) carried on `contents[]`, and the
cause was the same broken `contents[]` conversion as (3) and (4) — see "common cause" below.
**The first round trip works and the conversation empties on the second**, once a tool result is
sent back, which is a failure watching only the declaration will never reveal.

`functionCall` now becomes unified `tool_calls` and `functionResponse` a `role: 'tool'` message.
Gemini packs results together onto a user turn while unified follows OpenAI in giving each result
its own message, so one `contents[]` entry can produce several messages.

**The id synthesis rule** is the crux. A Gemini `functionResponse` normally carries no id, so it is
matched to a call by function name and arrival order and given `gemini_call_<name>_<n>`. The
counter never decreases, so calling the same tool twice cannot bind the second result to the first
call (`__tests__/parity/tool-use.test.ts`, "repeated calls to the same tool"). A result with no
matching call becomes `gemini_call_<name>_orphan` — a client is allowed to trim older turns, so it
is given a destination rather than discarded.

`toolConfig.functionCallingConfig` is read too, as the exact inverse of `buildToolConfig`. `ANY`
with a single `allowedFunctionNames` becomes OpenAI's function form; several become `required`.
Both the upper case the wire carries (`AUTO` / `ANY` / `NONE`) and the lower case our own outbound
emits are accepted.

### (3) gemini × system prompt — **fixed** (2026-09-01)

`GeminiInboundRequestSchema` (`src/schemas/wire/gemini/content.ts`) declares `systemInstruction`
(and snake_case `system_instruction`), and `transformRequestOut` maps it onto a unified
`role: 'system'` message. It is **stacked ahead of contents[]**, so it works even with a provider
that only honours a leading system message.

Multiple parts are joined with newlines into a **plain string**. The system prompt on the other
three surfaces is a string too; leaving gemini's as a block array would fork the shape per surface.

### (4) gemini × image input — **fixed** (2026-09-01)

`GeminiInboundPartSchema` declares `inlineData` / `fileData` and maps them onto unified `image_url`
blocks. inlineData is rebuilt as `data:<mime>;base64,<payload>` — `buildImagePart` in
`request-content.ts` splits on the comma to recover the base64, so a gemini → gemini round trip
returns the original shape. `media_type` is kept as well; the Anthropic outbound needs it to build
`source.media_type`.

Google's JSON mapping accepts both camelCase and the proto's snake_case, so both
`inlineData.mimeType` / `inline_data.mime_type` and `fileData.fileUri` / `file_data.file_uri` are
read. Reading only one spelling makes images vanish depending on the client.

### The common cause behind (2)(3)(4)(8) — `contents[]` conversion dropped the body (fixed)

The gemini column was not missing four features independently; it had **one bug**.

`GeminiInboundContentObjectSchema` declared `text: z.string().default('')`, so in
`inboundContentToMessage` (`src/llms/utils/gemini-request.ts`)

```ts
if (typeof content.text === 'string') {
  return { role: 'user', content: content.text.length > 0 ? content.text : null }
}
```

was **always true**, and the `role === 'user'` / `role === 'model'` parts branches below it were
never reached. So Gemini's canonical wire form

```json
{ "contents": [{ "role": "user", "parts": [{ "text": "hello" }] }] }
```

became `[{ role: 'user', content: null }]` — **the body disappears and the `model` role collapses
into `user`**.

The fix has two halves: drop `.default('')` so `text` is genuinely optional, and reorder the
branches to **"parts if present, else text, else discard"**. Either half alone leaves one of the
legacy `{ text }` form and the canonical form silently dropping again. A missing `role` is also
treated as `user` now — Gemini's API makes it optional, and such an entry used to be discarded
whole.

The inbound conversion lives in `src/llms/utils/gemini/inbound-request.ts`, paired with the
outbound `request-content.ts` / `request-config.ts`.

`generationConfig.maxOutputTokens` / `temperature` / `thinkingConfig` are read now too. That a
`generationConfig.temperature` of `0` does not turn into the default is tested explicitly — it is
the value a `||` fallback loses, and the one a client asking for deterministic output always
sends.

The bypass path (gemini surface → Google provider) never ran this conversion, so it was unaffected.
Which means this was an "unsupported" that **broke the moment the gemini surface was set to
`routed`**.

### (5) messages × thinking — supported, but the block order is inverted

Both directions work: the request (`thinking.budget_tokens` → `reasoning.effort`) and the response
(the `thinking` block). But `convertOpenAIResponseToAnthropic`
(`src/llms/transformers/anthropic/response-blocking.ts`) stacks annotation → text → tool_use →
**thinking**, while Anthropic itself puts thinking first. The gemini side writing the same
conversion (`buildParts` in `gemini-inbound-response.ts`) explicitly orders thinking → body →
tools, so the order is forked between surfaces.

`thinking.type === 'adaptive'` sets no unified `reasoning`, because there is no budget to
translate. It still counts for the think lane in scenario classification, and that asymmetry is
intended.

### (6) chat/completions × thinking — lost only on the aggregation path

On the non-streaming pass-through path `message.thinking` arrives intact. It is lost on the path
where an SSE upstream serves a `stream: false` client (codex-oauth), because
`aggregateOpenAiChatSseToJson` does not fold `delta.thinking`. **Behaviour forks by path within one
surface**, which is what makes this cell awkward.

### (7) responses × thinking — the request goes through, the response carries nothing

`reasoning: { effort }` survives into unified and reaches the upstream. The return is the problem:
`convertChatCompletionToResponses` (`src/llms/transformers/openai/responses/inbound.ts`) assembles
only `message` and `function_call` items. With no counterpart to the Responses API's own
`reasoning` item, the Codex CLI cannot see the thinking.

### (8) gemini × thinking — **fixed** (2026-09-01)

The response direction was always correct, coming back as a `thought: true` part with thinking
first, as Google orders it. The missing half was the request: `generationConfig.thinkingConfig` was
never read, which is part of the common cause above.

`thinkingLevel` (Gemini 3) now maps straight onto `reasoning.effort`, and older models'
`thinkingBudget` is rounded to a level by `getThinkLevel`. **That rounding is the same function
`/v1/messages` applies to Anthropic's `budget_tokens`** — "8192 tokens of thinking" must not mean
different things on different surfaces. `thinkingBudget` is also kept in `reasoning.max_tokens`, so
a round trip through `buildGenerationConfig` on the outbound returns the budget.

`thinkingLevel` is read as a string rather than an enum. Google adds thinking levels, and a strict
enum would turn one unrecognised value into a 500 for the whole request. A value that cannot be
read falls back to `includeThoughts` alone and becomes `reasoning: { enabled: true }`.

A `thought: true` part from a previous turn lands in unified's `thinking` field, not in `content`.
Mixed into the body, the model's private reasoning reaches the next provider **as if the user had
said it**.

### (9) gemini × usage record — **fixed** (2026-09-01)

A RequestLog row is assembled from two sources.

- **Surface attribution** (the `inboundType` / `surface` columns) — stamped from the descriptor by
  `resolveInvocationForModel`. Correct on all four surfaces.
- **Token counts** — read by `captureUsage` (`src/llms/pipeline/usage-extraction.ts`) from a clone
  of the **raw upstream response, before conversion**. `sendToProvider` clones ahead of
  `processResponseTransformers`, so the vocabulary that can be read is decided by the
  **provider's** wire format.

`UsageBlockSchema` (`src/schemas/domain/usage-record.ts`) declared only the Anthropic and OpenAI
names, not Gemini's `usageMetadata` (`promptTokenCount` / `candidatesTokenCount` /
`cachedContentTokenCount`). When `extractUsage` returns null, `captureUsage` returns immediately,
so **not one row was written** — Gemini traffic appeared in neither the Activity screen nor the
cost figures.

The gemini surface's default counterpart is the Google provider, which takes the bypass path, so
this was not confined to the conversion path: it **happened in ordinary use of the gemini
surface**. That makes it the one cell in this table that failed on the bypass path too, and the
heaviest of them.

**The fix**: add Gemini's three fields to `UsageBlockSchema` and let
`JsonResponseWithUsageSchema` accept a `usageMetadata` at the response root, since Gemini does not
put it under `usage`. The SSE side gained `GeminiUsageChunkSchema` — Gemini carries cumulative
values on many chunks, so the last one seen wins. `cachedContentTokenCount` is treated as an
**inclusive** count like (10), which the SDK states plainly: "When `cached_content` is set, this
also includes the number of tokens in the cached content".

No migration was needed. The `RequestLog` columns were there all along; nothing was arriving to
fill them.

### (10) chat/completions × cache tokens — **fixed** (2026-09-01)

OpenAI Chat Completions returns `usage.prompt_tokens_details.cached_tokens`; Responses returns
`usage.input_tokens_details.cached_tokens`. `UsageBlockSchema` declared **only the latter**, so a
cache hit on the Chat path was recorded as zero — the bill was in fact discounted while Activity
showed the full price.

Declaring `prompt_tokens_details` resolved that. But **adding the field alone introduces a
different bug**, so the summing was corrected with it.

**The two vendors count by opposite conventions.** Anthropic's `input_tokens` is the uncached
portion only, with the cached count beside it as `cache_read_input_tokens` (they add up to the
total). OpenAI's `cached_tokens` is a **breakdown of** `prompt_tokens` / `input_tokens` and is
**already included**, exactly as its SDK types put it: **"Cached tokens present in the prompt"**.
`computeTokenStats` added unconditionally, Anthropic-style, so on the OpenAI side the input of any
request with a cache hit was inflated by the hit (the Responses path, which read
`input_tokens_details`, had carried this error **all along**).

`cachedInputTokens()` now decides which convention applies and subtracts before summing on the
OpenAI side. The `RequestLog` columns keep Anthropic's convention (`inputTokens` = uncached,
`totalInputTokens` = the total).

This also corrected the `openai-responses` fixture in `__tests__/parity/cache-tokens.test.ts`. It
used `input_tokens: 20` with 80 cached — **a payload OpenAI never issues** — which happened to
reconcile with the Anthropic-style sum.

### (11) responses × cache tokens — recorded, but lost on the way back

`input_tokens_details.cached_tokens` is read onto `cacheReadTokens` (the double counting in the sum
is fixed by (10)). The loss is in the return direction: the usage
`convertChatCompletionToResponses` builds has only `input_tokens`, `output_tokens` and
`total_tokens`, so the Codex CLI's cache display always reads zero.

On `cacheWriteTokens` being 0, this note originally said "OpenAI has no equivalent of a write" and
**that was wrong**. `node_modules/openai`'s types declare `cache_write_tokens` ("The unadjusted
number of prompt tokens written to cache") on both Chat and Responses. `UsageBlockSchema` does not
read it, so writes on the OpenAI side go unrecorded. Reading it is small, but it cannot land before
confirming whether it is included in `prompt_tokens` — if it is, the same subtraction as (10) is
needed — so it **stays unsupported** for now.

### (12) gemini × cache tokens — **fixed** (2026-09-01), covered by (9)

This began as "before there is anywhere to read `cachedContentTokenCount`, no row is written at
all". The fix in (9) made the rows appear, and `cachedContentTokenCount` is now read as a breakdown
along with them. The return direction (`toUsageMetadata` emitting `cachedContentTokenCount`) was
already correct.

## Confirmed not to vary by surface

The following run through **one implementation** on all four surfaces. These rows are backed not by
"each surface works" but by a proof that **no surface differs**.

| Subject | Implementation | What shows it never looks at the surface |
|---|---|---|
| Building the failover chain | `src/api/v1/candidate-chain.ts` | `__tests__/parity/failover-429.test.ts` |
| Classifying 429 / `insufficient_quota` | `src/api/v1/upstream-error.ts` | same |
| Sub-account rotation and exhaustion marks | `src/api/v1/chain-failover.ts` | same (an identical chain shows there is no per-surface branch) |
| Choosing the error envelope | `src/api/v1/error-shape.ts` | `__tests__/parity/error-envelope.test.ts` |
| Choosing the non-streaming aggregator | the descriptor's `aggregateSse` | `__tests__/parity/non-stream-aggregate.test.ts` |
| Refusing an upstream response no client can parse | `findSseStreamDefect` in `src/llms/utils/sse-aggregate/parse.ts` | `__tests__/llms/sse-aggregate.test.ts` (all three vocabularies detected by one function) |

**The envelope a failure comes back in is the only thing that varies by surface.**

### What counts as a failure on the aggregation path

The aggregators are forgiving on purpose — a stream cut off mid-block still folds into a coherent
envelope, because a partial answer beats a 500. That forgiveness used to extend one step too far:
a stream carrying *no* foldable event, or one ending in an upstream `error` event, folded into a
husk (`{"content":[]}` on messages) that was then relayed under the upstream's `200`. Clients
report that as an empty or malformed response and cannot retry it, because a 200 is a success.

`findSseStreamDefect` draws the line before the fold, and it needs no per-surface vocabulary to do
it: all four wire formats signal a mid-stream failure with a top-level `error` object, and "no
events at all" is not a vocabulary question. A defect becomes the caller's own error envelope under
a real status — the upstream's when it named one (`error.code` on google, `error.type` mapped back
through the same table `error-shape.ts` maps forward), 529 for `overloaded_error`, otherwise 502.
The same rule covers a non-SSE upstream that returns an empty body.

## Surface parity for routing

Before the matrix comes a prior question: can routing be turned on per surface at all
(master-plan §2-5's second completion condition). This used to be hard-coded in
`scenario-router.ts`, where anything but `/v1/messages` passed through unconditionally — which made
the entire Routing screen a `/v1/messages`-only screen. The mode is now a value on
`InboundSurfaceConfig` and all four behave symmetrically
(`__tests__/parity/routing-mode.test.ts`).

**The classifier's dependence on Anthropic's vocabulary is gone** (2026-09-01). This section used
to say "a surface can be set to `routed`, but anything other than `/v1/messages` falls almost
entirely to the `default` lane". The classifier and the **rule predicates** read `body.thinking` /
`body.output_config.effort` / `tools[].type` directly, so a surface could have its mode set while
no road existed to the lane behind it.

`src/llms/scenario-router/surface-signals.ts` now absorbs the per-surface vocabulary differences,
and the classifier, the rule predicates and token counting all read only from there.

| Lane | Signal read (normalised) | Surfaces that can select it |
|---|---|---|
| `longContext` (size) | `signals.tokenize`, built per surface from `messages` / `input` / `contents` | all four |
| `longContext` (effort/tier) | `signals.effort`, and the model name's tier | all four, with the asymmetry below |
| `webSearch` | `signals.webSearch`, decided on meaning across each vendor's spelling | all four |
| `think` | `signals.thinking` | all four |
| `default` | none of the above matched | all four |

Reachability is backed by `__tests__/parity/routing-lanes.test.ts` (16 tests), which requests each
lane **in the spelling that surface's clients actually send** — a test pre-converted to the
Anthropic shape would verify nothing about the normalisation.

Three asymmetries remain. None can be closed, so they are stated explicitly.

- **Persona injection is `/v1/messages` only** (deliberate). Adding a top-level `system` on an
  OpenAI-compatible surface makes the upstream — codex being the standing example — answer 400 for
  an unknown parameter.
- **The two OpenAI surfaces never reach the effort → longContext escalation** when a think lane is
  configured. Anthropic has `thinking` and `output_config.effort` as **two independent fields** and
  can express "try hard, but do not think"; **OpenAI has one knob** (`reasoning_effort`). Any
  effort other than `'none'` is necessarily also an opt-in to reasoning, so `think`, which comes
  first in the branch order, always wins. A constraint of the vendor's vocabulary, not a gap in the
  implementation.
- **`minimal` / `none` round up to `low`.** `EffortLevel` has no step below `low`. Dropping them to
  `undefined` would read as "said nothing" and fall through to escalation by model tier — and a
  caller who explicitly asked for the cheapest inference **has said something**.

## How to fix an unsupported cell

The test behind an unsupported cell is written to **pin the current, broken behaviour** (note (6)'s
`expect(Reflect.get(Object(choices[0].message), 'thinking')).toBeUndefined()`, for example). That
is deliberate: fixing the implementation makes the test fail, which forces this document to be
updated. The gemini column's fix on 2026-09-01 began exactly that way, by breaking eight tests.

1. Fix the implementation (in `src/`)
2. Invert the expectation in that cell's test (in `__tests__/parity/`)
3. Update this document's matrix and cell notes

`__tests__/parity/matrix.test.ts` checks that the matrix is filled at 10 rows × 4 columns, that
every label is one of the three, and that every note number referenced exists. A cell cannot be
added and left blank.
