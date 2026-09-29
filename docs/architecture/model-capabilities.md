# Model capabilities (subscription providers)

For the two subscription providers, `claude-code` and `codex`, Rialto keeps five
facts per model. Two of them change over a model's life; three do not, because a
model id is a pinned snapshot.

| Fact | Changes? | Source | When it is read |
|---|---|---|---|
| Model list | Yes | Claude Code: the public catalog ([claude-code-model-catalog.md](./claude-code-model-catalog.md)). Codex: `backend-api/codex/models` | Every Refresh |
| Price | Yes | The vendor's API pricing page and the committed price tables | Every Refresh |
| Context window | No | Claude: `GET /v1/models` `max_input_tokens`. Codex: `max_context_window` from its model list | Once per model |
| Effort levels | No | Claude: `GET /v1/models` `capabilities.effort`. Codex: `supported_reasoning_levels` | Once per model |
| Thinking-off settings (Claude only) | No | Probed through `count_tokens` | Once per model, after it is switched on |

The fixed facts are recorded in the `ModelCapability` table
(`src/services/model-capability-service.ts`). A row means the model's list entry
has been read. The context window is written to `Model.contextWindow`, where the
router and the UI already read it. No Refresh overwrites it after that; the
pricing scrape describes the vendor's *API*, which is not what the subscription
serves. For example, OpenAI's docs give gpt-5.6 a window of 1,050,000 tokens,
while Codex reports 872,000 for the same id.

## When the facts are read

`captureModelCapabilities()` records whatever is still missing. When nothing is
missing it costs two indexed queries, so every path that can make a model
reachable calls it:

- at server start (this covers models that were already switched on before an upgrade);
- at the end of every Refresh, and after a Codex account connects;
- whenever a model is switched on: the per-model toggle, a tier alias that enables a model, and a config save.

It works in two stages because they cost differently:

- **List facts.** One call to each vendor's model list answers for every model, so every listed row is recorded, switched on or not. A row the list does not describe stays unrecorded and is asked about again next time.
- **Thinking probe.** This is a dozen `count_tokens` calls per model, so it runs only on switched-on Claude Code models, the ones a request can reach.

Passes run one at a time, so a toggle during a Refresh waits behind it. Any
answer that is not a verdict leaves the fact unrecorded to be retried, rather
than recorded as "unsupported". That covers auth failures, rate limits, outages
and a refused control request.

## Effort levels

The recorded levels reach the UI and the pipeline as
`Provider.modelSupportedEfforts`. They drive:

- the per-model effort picker;
- which manual or Auto level may be sent ([adaptive-reasoning-effort.md](./adaptive-reasoning-effort.md));
- the clamp of a caller's `output_config.effort` on Claude Code (`api/v1/invocation.ts`).

For the clamp, a model whose list reports no level (Haiku 4.5) has the field
removed. A model that is not recorded yet is sent exactly as the caller wrote it.
api_key OpenAI models record nothing and keep the static table in
`shared/model-reasoning-effort.ts`.

## Thinking off on Claude

A caller turns thinking off with `thinking: {type: "disabled"}`. Whether the
target accepts that is a property of the model, and neither the Code catalog
nor `/v1/models` reports it:

| Model | `disabled` | `between_tools` |
|---|---|---|
| Sonnet 5 | accepted at every effort | refused |
| Sonnet 5.5 | refused | accepted at effort `high` or below |
| Opus 5 | accepted at effort `high` or below | refused |
| Opus 5.5, Fable | refused | refused |

The probe sends each setting to `count_tokens` at every recorded effort, plus
once with no effort. `count_tokens` validates `thinking` and `output_config`
exactly as `/v1/messages` does, but it runs no inference. The result reaches
the pipeline as `modelThinkingOff`.

`pipeline/thinking-off.ts` runs last in `sendToProvider`, after the manual and
Auto effort steps have settled the effort that will be sent. It works through
three cases in order:

1. It keeps `disabled` where the model takes it.
2. Otherwise it sends `between_tools` where the model takes that.
3. Otherwise it leaves `thinking` out, which is the closest the model allows: adaptive thinking, held down by the effort.

Each rewrite is logged as `thinking_off_fitted`. A model that has not been
probed yet is left alone.

This matters because the model a request lands on is Rialto's choice: a tier
follows the newest switched-on model its name says. Before this, a Claude Code
request with `disabled` that a tier moved onto Sonnet 5.5 came back as a 400.
