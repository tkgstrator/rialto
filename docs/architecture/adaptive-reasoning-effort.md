# Adaptive reasoning effort

As of 2026-09-27, a model's `auto` effort setting is an opt-in outbound policy. It reads the selected target's fresh subscription-quota projection on each upstream attempt. Below 60% pace it aims for `high`; from 60% through 100% it aims for `medium`; above 100% it aims for `low`. It chooses only a confirmed positive level supported by that model/account, preferring the target rung or the closest lower rung. It never chooses `none` automatically. Manual model overrides and explicit client reasoning controls take precedence. Missing, stale, degraded, exhausted or invalid quota data, or unknown model support, leaves the request unchanged. An API-key target normally has no subscription reading, so Auto does not alter it.

## Public OpenAI API model support

These are **individual model IDs**, not a global API enum. Each entry below comes from a model-specific statement on an official model page or guide. The `none` value is a supported *manual* choice only, never an Auto outcome.

| Model ID | Confirmed supported values | Source |
|---|---|---|
| `gpt-5` | `minimal`, `low`, `medium`, `high` | [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-5) |
| `gpt-5.1` | `none`, `low`, `medium`, `high` | [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-5.1) |
| `gpt-5.2` | `none`, `low`, `medium`, `high`, `xhigh` | [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-5.2) |
| `gpt-5.4` | `none`, `low`, `medium`, `high`, `xhigh` | [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-5.4) |
| `gpt-5.4-mini` | `none`, `low`, `medium`, `high`, `xhigh` | [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-5.4-mini) |
| `gpt-5.5` | `none`, `low`, `medium`, `high`, `xhigh` | [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-5.5) |
| `gpt-5.6` | `none`, `low`, `medium`, `high`, `xhigh`, `max` | [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6) |
| `gpt-5.6-terra` | `none`, `low`, `medium`, `high`, `xhigh`, `max` | [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-5.6-terra) |
| `gpt-5.6-sol` | `none`, `low`, `medium`, `high`, `xhigh`, `max` | [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol) |
| `gpt-5.6-luna` | `none`, `low`, `medium`, `high`, `xhigh`, `max` | [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna) |
| `gpt-6-astra` | `low`, `medium`, `high`, `xhigh`, `max` (`none` is rejected) | [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-6-astra) |
| `gpt-6-sol` | `none`, `low`, `medium`, `high`, `xhigh`, `max` | [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-6-sol) |
| `gpt-6-luna` | `none`, `low`, `medium`, `high`, `xhigh`, `max` | [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-6-luna) |

The [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning?api-mode=responses) names a global superset (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) but explicitly says support varies by model. Other IDs, including dated snapshots, GPT-5 Mini/Nano, Codex variants and o-series models, remain unknown to the **static** support map until their exact capabilities are established. In particular, a model-family naming pattern is not proof of an effort set. An already-stored manual value remains selectable for editing even when it is absent from the documented set; Auto does not infer support from it.

## Claude Code subscriptions

Claude Code models carry no static table. Each model's levels come from Anthropic's `GET /v1/models` `capabilities.effort`, read once with the subscription's own token and recorded ([model-capabilities.md](./model-capabilities.md)). A model not recorded yet grants Auto nothing and leaves the request's effort as the caller sent it. A model whose list reports no level at all (Haiku 4.5) has a caller's `output_config.effort` removed rather than forwarded to a 400. The [Messages API documents](https://platform.claude.com/docs/en/build-with-claude/effort) the outbound `output_config.effort` field. The native Claude Code traffic already carries `output_config`, and Rialto preserves it only on Claude Code subscriptions.

Auto injects `output_config.effort` just before dispatch, after account selection; manual overrides take priority and only recorded levels are emitted. Explicit caller effort or thinking controls prevent Auto, including `thinking: disabled`. The request is fresh for each fallback and account rotation. Top-level effort changes between turns [can invalidate a cached prefix](https://platform.claude.com/docs/en/build-with-claude/effort#top-level-effort-on-the-next-request); Auto is therefore opt-in and may reduce cache reuse on a long-lived session.

## Codex subscription accounts

The public API contract above is **not** evidence for the ChatGPT Codex backend. For a Codex subscription, each visible model's `supported_reasoning_levels[].effort` from `backend-api/codex/models` is read once and recorded per model ([model-capabilities.md](./model-capabilities.md)). This includes `ultra`, a level above `max` that some Codex models offer. Levels this build cannot name, hidden models and failed reads grant no Auto permission. A model not recorded yet leaves the request's effort untouched rather than failing dispatch.
