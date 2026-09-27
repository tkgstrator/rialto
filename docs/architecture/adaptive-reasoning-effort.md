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

[Claude Code's model configuration](https://code.claude.com/docs/en/model-config) confirms `low`, `medium`, `high`, `xhigh`, `max` for the exact IDs `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-5`; `claude-opus-4-6` and `claude-sonnet-4-6` support `low`, `medium`, `high`, `max`, **not** `xhigh`. Haiku, Mythos, Opus 4.5 and unverified date-suffixed IDs are not inferred from the public API's different model list. Claude Code's documentation describes CLI effort settings but does not independently specify its OAuth wire protocol; the [Messages API documents](https://platform.claude.com/docs/en/build-with-claude/effort) the outbound `output_config.effort` field. The native Claude Code traffic already carries `output_config`, and Rialto preserves it only on Claude Code subscriptions. The subscription-backend path is covered by mock-upstream tests, not a live OAuth entitlement test.

Auto injects `output_config.effort` just before dispatch, after account selection; manual overrides take priority and only documented Claude Code values are emitted. Explicit caller effort or thinking controls prevent Auto, including `thinking: disabled`. The request is fresh for each fallback and account rotation. Top-level effort changes between turns [can invalidate a cached prefix](https://platform.claude.com/docs/en/build-with-claude/effort#top-level-effort-on-the-next-request); Auto is therefore opt-in and may reduce cache reuse on a long-lived session.

## Codex subscription accounts

The public API contract above is **not** evidence for the ChatGPT Codex backend. For a Codex subscription, the selected account's live `backend-api/codex/models` response supplies each visible model's `supported_reasoning_levels[].effort`. Unknown effort strings, hidden models, incomplete catalogs and failed reads grant no Auto permission. Capabilities are cached by sub-account for five minutes and fetched on demand after account selection; another account's levels are never substituted. This permits two accounts serving the same model to have different available rungs. A catalog outage leaves the request's effort untouched rather than failing dispatch.
