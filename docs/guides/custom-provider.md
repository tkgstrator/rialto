# Custom provider

A **Custom** provider is an endpoint Rialto has no catalog entry for: a local server such as LM
Studio, Ollama or vLLM, a self-hosted gateway, or a hosted vendor that is not in the Add provider
list. It is added by hand in **Providers -> Add provider -> Custom**, and from then on it is an
ordinary `Provider` row: it can be switched on, put in a tier route, tested and edited like any
other API-key provider.

## What you enter

| Field | Rule |
|---|---|
| Name | Lowercase letters, digits, `.`, `-` and `_`, at most 48 characters. It names the provider in routing and logs and cannot be changed later. Must not be a built-in vendor (`openai`, `anthropic`, `google`, `deepseek`, ..., `claude-code*`, `codex`, `gemini-cli`) or an SPA route segment, and must not already be a provider (compared case-insensitively). |
| Base URL | An `http://` or `https://` address, with or without `/v1`. No username, password, query or fragment. Private and loopback addresses are allowed. |
| Wire format | One of three: **Claude** (Anthropic Messages, `api_style = anthropic`), **OpenAI Chat Completions** (`openai_chat`), **OpenAI Responses** (`openai_responses`). `gemini` is not offered: its URL carries the model and its key travels as a query parameter, which a Base URL cannot describe. |
| API key | Required. The request pipeline skips a provider with no key, so a keyless one could never be served. A local server that checks no key takes any placeholder. |

The auth mode is always `api_key`.

## What is stored

`POST /api/providers/custom` turns the form into the ordinary provider row; there is no parallel
mechanism:

- `api_base_url` is the full endpoint, which is what every built-in vendor stores too. It is derived
  from the Base URL and the wire format (`customEndpointUrl` in `src/shared/custom-provider.ts`).
  The form previews the same string under the field ("Requests go to").
- `api_key` and `api_style` are the typed key and the chosen format. The transformer chain is then
  derived from `api_style` + `auth_mode` like for any provider (`src/shared/transformer-chain.ts`).
- The provider lands **switched off**, with every model off. What it may serve is decided in the last
  step of the Connect flow, not guessed.

| Base URL typed | Wire format | Stored endpoint |
|---|---|---|
| `http://localhost:1234` | Chat Completions | `http://localhost:1234/v1/chat/completions` |
| `http://localhost:1234/v1` | Responses | `http://localhost:1234/v1/responses` |
| `https://gw.example.com/anthropic` | Claude | `https://gw.example.com/anthropic/v1/messages` |
| `https://gw.example.com/chat/completions` | Chat Completions | `https://gw.example.com/chat/completions` (an endpoint typed in full is taken literally) |

The OpenAI tail chosen here is only the provider's default. The send path retargets
`/chat/completions` <-> `/responses` per model (`src/llms/utils/openai-endpoint.ts`), so the
per-model API style override on the provider page (Request shape) keeps working on a Custom
provider. A model named like a Codex model is **not** forced onto Responses here, and the
deprecation registry does not apply: the endpoint serves whatever its operator put behind it.

## Models

On Connect, Rialto looks up the endpoint's model list once (`fetchCustomModels` in
`src/vendors/custom.ts`):

1. `GET {base}/models`, trying `/v1/models` first for a bare origin and not doubling `/v1` for a base
   that already ends in it, then the sibling spelling.
2. Claude format sends `x-api-key` and `anthropic-version`; both OpenAI formats send
   `Authorization: Bearer`.
3. Redirects are **not** followed: `x-api-key` is not stripped by `fetch` when a redirect leaves the
   origin, so following one would hand the key to wherever the server points. The error says where it
   points so the stored address can be corrected.
4. The wait is capped at 8 seconds.

If a list comes back, its ids become the provider's models, all switched off. If it does not (no
`/models`, a wrong key, a timeout, an empty or unrecognised body), the provider is still created and
step 3 says what the endpoint answered and offers **Add a model by ID**. Manual entry always works and
is the fallback: a typed id is added through the normal provider save and starts switched on.

Prices, context windows and legacy flags are unknown for a Custom model and stay `null`, which is the
existing "vendor does not publish" reading. Nothing needs a price to work.

## What the background jobs do

A Custom provider has no vendor adapter, no price sheet and no catalog page, so the jobs leave it alone
rather than fail on it:

- **Refresh models** reports it as `skipped: "custom provider: models are managed by hand"`, not as an
  error, and makes no outbound call for it.
- **Static price backfill** does not apply a catalog vendor's list price to a Custom model that happens
  to share a name (`gpt-4o` behind LM Studio is not OpenAI's `gpt-4o`).
- **Test** on the provider page runs the same model-list lookup as Connect, so "reachable and the key is
  accepted" means the same thing in both places. A server that serves no `/models` therefore reads as
  failing there even if its chat endpoint works.

A provider counts as Custom when it is `api_key` and its name is not a built-in vendor
(`isCustomProvider`). Nothing else marks the row, which also makes a legacy API-key provider carried
over under an unknown name count as Custom; it has no vendor adapter either, so skipping it is correct.

## Outbound requests to user-supplied URLs

Rialto does not guard outbound user-supplied URLs elsewhere (the only handling today is
`stripUrlSecrets` when logging a send in `src/llms/pipeline/provider-send.ts`), so this feature adds no
SSRF filter. The Providers UI is admin-only and authenticated, and local gateways (LM Studio, Ollama)
are a main use case, so private and loopback addresses are allowed on purpose. What is enforced:
http(s) only, no credentials/query/fragment in the stored URL, redirects not followed on the model
lookup, and a bounded wait. If Rialto is ever exposed to people who must not be able to point it at
internal hosts, a deny-list belongs in `parseCustomBaseUrl` and on the send path together.

## Where it lives

| Concern | File |
|---|---|
| Name, Base URL, endpoint and models-URL rules (shared by the form and the server) | `src/shared/custom-provider.ts` |
| Model-list lookup | `src/vendors/custom.ts` |
| Create (name check, lookup, upsert) | `src/services/custom-provider-service.ts` |
| Route and request/response schemas | `src/api/providers/custom/route.ts`, `src/schemas/api/providers.ts` |
| Style stored on the row and per-model override | `src/services/config/api-style.ts` |
| Sync and price-job skip | `src/services/model-sync-service.ts` |
| Connect flow UI | `src/components/rialto/providers/ConnectCustomStep.tsx`, `ConnectCustomModels.tsx`, `custom-form.ts` |
| Mocks (agent-authored, pending human approval) | `mocks/providers-connect-custom.html`, `mocks/providers-connect-custom-models.html` |
