[![](https://img.shields.io/badge/🇬🇧-English-000aff?style=flat)](README.md)
[![](https://img.shields.io/badge/🇯🇵-日本語-bc002d?style=flat)](README_ja.md)
[![](https://img.shields.io/badge/🇨🇳-中文版-ff0000?style=flat)](README_zh.md)
[![Discord](https://img.shields.io/badge/Discord-%235865F2.svg?&logo=discord&logoColor=white)](https://discord.gg/rdftVMaUcS)
[![](https://img.shields.io/github/license/tkgstrator/rialto)](https://github.com/tkgstrator/rialto/blob/master/LICENSE)

<hr>

> A routing gateway for LLM traffic: it accepts four wire formats on the front door and dispatches each request to whichever vendor you configured — without changing your client's setup.

## ✨ Features

- **Four inbound surfaces** — Anthropic Messages (`/v1/messages`), OpenAI Chat Completions, OpenAI Responses, and Gemini `generateContent`. Everything a surface needs is one descriptor, so all four get the same auth, error envelopes, streaming and request history.
- **Passthrough-only dispatch** — the caller's `body.model` wins. A bare model name resolves to its upstream by provider priority, a `provider,model` pair picks one directly, and Rialto never rewrites the model on the caller's behalf.
- **Plans on access tokens** — a token may carry a Plan, and a Plan names the models that token may use (`provider,model` list, with an optional default when none is sent), plus 5-hour and 7-day request / money limits. A model the Plan does not list is refused **403**, not redirected.
- **Failover with account rotation** — a 429 rotates to a peer subscription account first, then to the next provider that hosts the same bare name. The `provider,model` form opts out of fallback by pinning a single upstream.
- **Personas** — append a named system prompt to every `/v1/messages` request without touching Claude Code. Manage the library and pick the active one under Settings → Personas.
- **Multi-provider support** — connect API-key providers (Anthropic, OpenAI, DeepSeek, Gemini, Groq, OpenRouter, …) or subscription-based providers (Claude Code OAuth, OpenAI Codex), with several accounts per subscription provider.
- **Subscription monitoring** — each account's rate-limit windows, refreshed on demand from the Subscriptions list, and the exhaustion state the router reads. A refresh reaches routing at once, and a Codex account's banked rate-limit resets can be spent from its provider page.
- **Usage & cost** — spend for today, this week and this month on Overview; per-provider cost by day or week, and per-account subscription usage, under Activity → Usage. Overview and each subscription provider's page also show, per account, what its traffic would have cost at API prices — this week and over 30 days.
- **Request history** — browse past sessions with per-request stats and archived conversation transcripts.
- **Issued access tokens** — individually revocable and rotatable, attributable per request, scopeable to a set of surfaces, and bound to an optional Plan that gates the models and the rate limits they may use.
- **Web management UI** — full browser-based configuration in English, Japanese or Chinese; no manual JSON editing required.
- **Transformer pipeline** — the chain is derived from the provider's API style and auth mode, so what the UI shows is what runs.
- **Docker-first deployment** — single `docker compose up -d` with PostgreSQL and Redis included.

## 🖥️ Web UI

The web UI (served on port **3456** by default) gives you full control over every aspect of the gateway. It is organised as five screens:

| Screen | Route | Purpose |
|--------|-------|---------|
| **Overview** | `/overview` | Spend, subscription quota windows, and requests / errors per inbound surface at a glance |
| **Providers** | `/providers` | Two lists — `/providers/subscriptions` and `/providers/api-keys` — plus `/providers/connect` to add one and `/providers/<name>` for models, prices, context windows, connectivity tests and the read-only derived request shape |
| **Access tokens** | `/access-tokens` | Issue, scope, rotate and revoke the tokens clients use on `/v1/*`. Each token picks its inbound surfaces and attaches to a Plan — the Plan is what grants its models and rate limits |
| **Activity** | `/activity` | Sessions, per-request logs (`/activity/requests`), subscription usage (`/activity/usage`), and server logs (`/activity/logs`) |
| **Settings** | `/settings` | Server, Access (admin access: Cloudflare Access, and how to get back in if it breaks), Logging, Personas, Advanced (config document, health) |

First run lands on `/setup`.

> There are no screenshots of the current interface yet. The images that used to live under `docs/images/` showed the retired pre-Rialto UI and have been deleted rather than left in place as a wrong picture of the product.

## 🚀 Quick Start with Docker (Recommended)

Install [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/), then:

**Step 1 — Create a working directory and download `compose.yaml`:**

```shell
mkdir -p ~/rialto
cd ~/rialto
curl -fsSL https://raw.githubusercontent.com/tkgstrator/rialto/master/compose.yaml -o compose.yaml
```

The compose file runs `ghcr.io/tkgstrator/rialto:latest` with PostgreSQL and Redis, publishes port `3456`, and bind-mounts `./rialto-config` as the container's `~/.rialto` — that directory is where `config.json` lives on the host. It also mounts `~/.claude` and `~/.codex` for the CLI credential files; drop those two lines if you only use API-key providers.

A config file is created for you on first boot, so there is nothing to write before starting. Every envelope scalar can also be supplied as an environment variable on the `rialto` service (`PORT`, `LOG_LEVEL`, …); a set environment value wins over the file.

> **There is no admin key.** A browser on the machine Rialto runs on is exempt from the admin gate, and remote admin access goes through Cloudflare Access. If Access breaks, SSH to the host and forward the port — see [Public deployment](#-public-deployment).
>
> **`/v1/*` takes access tokens only.** Clients call the proxy with an *access token* you issue under **Access tokens** — individually revocable, attributable per request, scopeable to surfaces, and gated by an optional Plan. An install with no tokens issued cannot proxy.

**Step 2 — Start the services:**

```shell
docker compose up -d
```

The entrypoint applies pending Prisma migrations and the seed before the server starts. The server then listens at `http://127.0.0.1:3456`. Open that URL in a browser and use the **Providers** page to connect at least one upstream, then issue a token under **Access tokens** — that is what your clients authenticate with. Attach a Plan to the token if you want to restrict which models it may call.

**Step 3 — Point Claude Code at the gateway:**

```shell
ANTHROPIC_BASE_URL=http://127.0.0.1:3456 ANTHROPIC_AUTH_TOKEN=rialto_your-access-token claude
```

Or set permanently in your shell profile:

```shell
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
export ANTHROPIC_AUTH_TOKEN=rialto_your-access-token
```

**View logs:**

```shell
docker compose logs -f
```

**Restart after editing `config.json` by hand:**

```shell
docker compose restart
```

Envelope values changed through the UI take effect immediately — they are mirrored onto the process environment as part of the save. There is no `rialto` CLI.

## 🔌 Connecting Providers

### API key providers

On the **Providers** page, choose **Add provider**, pick a vendor (Anthropic, OpenAI, DeepSeek, Gemini, etc.), paste your API key, and choose which models to enable. The key is stored in the database, not in `config.json`; only the models switched on here are dispatched to, and the rest stay listed so you can enable them later.

### Subscription providers (Claude Code & Codex)

Rialto can route through subscription-based providers without a per-call API key. Add one under **Providers → Add provider**. The Authenticate step differs by vendor, because the two vendors' OAuth clients return to different places.

**Claude**

- **Sign in with Anthropic** — opens Anthropic's OAuth page in your browser, which returns to `http://localhost:3456/callback`.
- **Paste the redirect URL** — when the browser cannot reach that callback (Rialto behind a tunnel, or a headless box), copy the URL Anthropic redirected to and paste it into the box; the code exchange runs server-side.
- **Import from Claude** — upload `~/.claude/.credentials.json` from a machine where you have already signed in.

**Codex**

- **Device code** (the default) — Rialto shows a one-time code and the link `https://auth.openai.com/codex/device`. Open it in any browser, sign in to ChatGPT and enter the code; the page moves on by itself once the code is accepted. The code expires after 15 minutes. Nothing has to reach back to Rialto, so this works behind a tunnel or in a container. It is the flow `codex login --device-auth` uses (`POST /api/oauth/device/start`, then `POST /api/oauth/device/poll`).
- **Import from Codex** — upload `~/.codex/auth.json` from a machine where you have already signed in.

Codex's browser sign-in is not offered: its OAuth client only redirects to `http://localhost:1455/auth/callback` on the machine the browser runs on, which a remote or containerised install never receives. The loopback listener behind it (port `1455`, still published by `compose.yaml`) is no longer used by the UI.

Rialto stores the encrypted tokens and refreshes them. A provider may hold several accounts; which one serves a request is decided per request (see [Failover and account rotation](#failover-and-account-rotation)). The Subscriptions list has a **Refresh** button (`POST /api/subscriptions/refresh`) that re-syncs every account on an enabled subscription provider and re-polls its usage past the 5-minute cache. Routing reads the fresh numbers immediately rather than at the next scheduler tick: the refresh republishes the quota snapshot and lifts the exhaustion marks an earlier 429 left on an account the vendor has since reset.

A Codex account can hold *banked* rate-limit resets. Its row on the provider page shows how many it holds, and **Use reset** spends one (`POST /api/subscriptions/accounts/{id}/reset-usage`) after a confirmation that says when the next one lapses. The button is live only while the vendor would accept a reset, which is while a window is spent. The account's usage is then re-read the same way as a refresh, so routing picks it up as soon as the reset lands. Nothing spends a reset automatically.

> **Terms of service notice:** Using a Claude Code subscription to serve requests from applications other than Claude Code may violate [Anthropic's usage policies](https://www.anthropic.com/legal/aup). Use this feature at your own discretion and risk.

## 🚪 Inbound surfaces

Rialto is not only a Claude Code proxy. Four wire formats are accepted on the front door, and each one is described by a single descriptor in `src/llms/inbound/surfaces.ts`:

| Surface | Path | Typical client | Credential | Error envelope |
|---|---|---|---|---|
| `anthropic-messages` | `POST /v1/messages` | Claude Code | `x-api-key` or `Authorization: Bearer` | `{type:'error', error:{type,message}}` |
| `openai-chat` | `POST /v1/chat/completions` | OpenAI SDK, Cline, OpenWebUI | `Authorization: Bearer` | `{error:{message,type,code,param}}` |
| `openai-responses` | `POST /v1/responses` | Codex CLI | `Authorization: Bearer` | `{error:{message,type,code,param}}` |
| `gemini-generate` | `POST /v1beta/models/<model>:<action>` | Gemini CLI | `x-goog-api-key`, `?key=` or `Authorization: Bearer` | `{error:{code,message,status}}` |

`GET /v1/models` and `POST /v1/messages/count_tokens` are catalog reads rather than completion surfaces, so they are not among the four — but they answer in the calling SDK's credential convention and error envelope, and a token scoped to some surfaces may still call them.

Whichever surface a request arrives on, the credential must be an **issued access token**. Nothing else is accepted.

## ⚙️ Configuration

### Disk envelope (`~/.rialto/config.json`)

Boot-time scalars and disk-resident objects live here. Environment-variable interpolation (`$VAR` / `${VAR}`) and JSON5 comments are supported. **There are no backups**: the file is overwritten in place on every save, and the only safety net is that an unparseable file is renamed aside (`config.json.invalid-<timestamp>`) rather than deleted. Unknown keys are preserved, not dropped.

| Key | Description |
|-----|-------------|
| `HOST` | Listen address (default: `127.0.0.1`) |
| `PORT` | Listen port (default: `3456`) |
| `ACCESS_TEAM_DOMAIN` | Cloudflare Access team domain. With `ACCESS_AUD`, verifies the Access assertion on `/api/*` |
| `ACCESS_AUD` | Access application AUD tag. Both must be set — one alone enables nothing |
| `LOG` | `true` to write log files (default `false`) |
| `LOG_LEVEL` | `fatal` / `error` / `warn` / `info` / `debug` / `trace` (default `info`) |
| `LOG_MAX_MB` | Size in MB at which a log file rotates (default `10`) |
| `PROXY_URL` | HTTP proxy for upstream API requests |
| `API_TIMEOUT_MS` | Bun's per-request idle timeout, in ms: converted to seconds and clamped to 1–255 s (default 255 s). It is not an upstream call timeout |
| `CLAUDE_PATH` | Declared and editable, but nothing in this build reads it — there is no CLI |
| `NON_INTERACTIVE_MODE` | Declared and editable, but nothing in this build reads it |
| `CAPTURE_REQUESTS` | Record a `RequestLog` row per request (default `true`) |
| `CAPTURE_MESSAGES` | Archive conversation transcripts (default `true`) |
| `REDACT_TOOL_ARGUMENTS` | Strip tool-call arguments from the archive (default `false` — turning it on loses information that cannot be recovered later) |
| `ROUTING_SCHEDULER_INTERVAL_MS` | Scheduler tick, 60 000–3 600 000 (default `300000`) |
| `Personas` | The persona library (array) |
| `ActivePersona` | The active persona's uuid id; `null` / absent / empty means none. Also a top-level key on the `/api/config` wire |

The scalar keys above (everything but `Personas` and `ActivePersona`) can also be supplied as process environment variables — a Docker `environment:` entry, for instance — and a set environment value wins over the file.

Keys an older build wrote for mechanisms that no longer exist are ignored. `Router`, `CUSTOM_ROUTER_PATH`, `LiveRoutingName`, `CROSS_PROVIDER_FALLBACK` and the retired admin key `APIKEY` are stripped on every read; `POST /api/config` drops them with a warning, and the next save removes them from the file. An `APIKEY` environment variable is not read either. `ROUTER_MODE` merely survives as an unknown key and is read by nothing.

### Providers and models (database)

Providers and their models live in PostgreSQL and are managed through the web UI (`POST /api/config`, `POST /api/inbound-surfaces`, `/api/providers/*`). The `Providers` key **inside** `config.json` is a one-way mirror written back from the database after each save — editing it by hand has no effect and is overwritten on the next write.

### Passthrough and Plans

Every surface is passthrough. The caller's `body.model` goes upstream as sent: a bare model name such as `gpt-5.5`, or the `provider,model` form. When several enabled providers host the same bare name, the order set in Providers → Priorities picks one and the rest become its fallbacks; with no order set, the request is refused rather than sent to an arbitrary provider. A surface can deny specific `provider,model` pairs (Inbound surfaces → Reachable targets).

**Plans gate what a token may ask for.** A token with no Plan can call any enabled model. A token with a Plan may call only the `provider,model` pairs the Plan lists. A request for a model the Plan does not list is refused **403** (in the surface's own error envelope — Anthropic `permission_error`, OpenAI `permission_error`, Google `PERMISSION_DENIED`) and is never redirected. When no model is named, the Plan's `defaultModel` is used; this is the only time a default applies. A Plan is shared across tokens — edit it once and every token using it picks up the change on its next request.

**Rate limits are per Plan.** 5-hour and 7-day windows cap request count and spend; a spent window answers 429 before anything else. Limits are enforced per access token (shared Plans share their caps across every token that uses them; the limits apply to each token's own 5-hour and 7-day windows).

Either way, a provider or model switched off on the Providers page is never dispatched — not from the first-picked upstream, not as a failover target, and not through a disabled subscription provider's accounts. Naming one by hand is refused rather than forwarded.

The full reference is [docs/architecture/routing.md](docs/architecture/routing.md).

### Failover and account rotation

A bare model name's chain is the first-priority provider that hosts it followed by the others, in priority order. Within one upstream, a subscription provider's accounts are rotated first:

- **Account rotation on 429** — for a subscription provider, a 429 marks that sub-account exhausted (until the reset of a binding window that is at least 90 % full, or five minutes if none is known) and retries the same target on a peer account, up to ten rotations. Only when no peer account is left does the model get marked and the walker move to the next provider. OpenAI's `insufficient_quota` marks the whole provider at once. A later success on the account lifts its mark.
- **The `provider,model` form opts out of fallback** — pinning a single upstream means a 429 on that provider's last account is returned to the caller rather than rotated to another upstream.
- **Multi-account balancing** — with several enabled accounts on the same provider, the account picker drops accounts whose recorded binding windows are already at 99 %, reuses the sticky session→account mapping when it still points at a survivor, and otherwise picks the account with the highest required burn rate — `remaining % ÷ hours until reset`, taken over its tightest binding weekly window — i.e. the one most at risk of leaving quota unspent. Ties go to the least recently picked account.

Decisions are logged structurally — the skipped upstream and the reason, at `warn` when the answer is a 429 or a 400, and at `info` otherwise.

### Personas

A *persona* is a named system-prompt fragment appended to every `/v1/messages` request. Use them to give Claude Code a consistent voice / role / set of working rules without editing Claude Code itself.

- **Library** — `Personas` is a top-level array on the disk envelope. Each entry has a stable uuid `id`, a free-form `name` (display label, need not be unique), and the `prompt` text. New installs ship with a small starter library; existing installs keep what they have on disk.
- **Active selection** — at most one persona is active per install. Its uuid id is the top-level `ActivePersona` key, on the disk envelope and on the `/api/config` wire alike. `null` / absent / empty string means "no persona". There are no per-project or per-session override files.
- **Injection** — the active persona's `prompt` is appended to the LAST system block carrying `cache_control` (falling back to the last string text block). This keeps the persona *inside* the cached prefix, so it consumes no extra cache breakpoint and stays byte-stable across requests (preserving Anthropic's prompt cache). String and undefined `system` values are concatenated; multi-block array systems are mutated in place.
- **Surface restriction** — persona injection runs on **`/v1/messages` only**. The OpenAI-compat and Gemini surfaces reject an enriched `system` field outright (Codex answers `Unsupported parameter: system`), so the enrichment is skipped there rather than breaking the request. Every `/v1/messages` request inherits the active persona, including one on a token with no Plan.
- **Subagent interaction** — persona injection runs *after* the subagent tag is stripped, so a subagent's per-call system content composes with — rather than clobbers — the persona.

Both the library and the active selection live under **Settings → Personas** (`/settings/personas`). "No persona" is the no-op default.

For authoring high-fidelity personas (structural patterns, anti-pattern cataloguing, thought-process control), see [docs/guides/persona-authoring.md](docs/guides/persona-authoring.md).

### Transformers

Transformers adapt requests to each provider's wire format. Six ship with Rialto and the set is fixed at build time — there is no plugin loader.

| Transformer | Bound to | Job |
|-------------|----------|-----|
| `anthropic` | `/v1/messages` | Native Anthropic wire format |
| `openai` | `/v1/chat/completions` | OpenAI Chat Completions |
| `openai-responses` | `/v1/responses` | OpenAI Responses API — Codex-family models |
| `gemini` | `/v1beta/models/:modelAndAction` | Google Gemini |
| `claude-code-oauth` | subscription auth | Injects the Claude Code OAuth bearer, with auto-refresh |
| `codex-oauth` | subscription auth | Injects the ChatGPT / Codex OAuth bearer |

**The chain is derived, not configured.** Every transformer above is either endpoint-bound or auth-bound, so there is no choice left to make: Rialto reads the chain off the provider's API style and auth mode.

| API style | api_key | subscription |
|---|---|---|
| `anthropic` | *(no conversion step needed)* | `claude-code-oauth` |
| `openai_chat` | `openai` | *not supported* |
| `openai_responses` | `openai-responses` | `openai-responses` → `codex-oauth` |
| `gemini` | `gemini` | *not supported* |

An Anthropic provider needs no conversion step because the request is already in that wire format. An unsupported pair means the provider is not registered at all, rather than being called without a credential.

A model whose own API style disagrees with its provider's — a Codex-family model hosted on the regular OpenAI provider — gets that conversion step appended for its own requests only.

There is no transformer setting to configure per provider. The Providers page shows the derived chain read-only under **Request shape**, which is the first thing worth checking when a request misbehaves.

### Subagent tag

A subagent tag at the start of the second system block marks a request as subagent traffic:

```
<RIALTO-SUBAGENT-MODEL>subagent</RIALTO-SUBAGENT-MODEL>
Please help me analyze this code...
```

Only its presence is read; its contents are ignored. The tag is recorded on the request log (`RequestLog.isSubagent`) so Activity can tell subagent traffic apart, and it is stripped before the request goes upstream so the marker never reaches the vendor. It routes the request nowhere special — the caller's `body.model` is still what wins — the tag is an audit signal.

`<CCR-SUBAGENT-MODEL>` is the pre-rename spelling and is still recognised and stripped, because it lives in prompts people have already written. A tag whose body still names a `provider,model` pair is harmless; the pair is simply not read.

## 🔀 OpenAI-compatible and Gemini-compatible API surfaces

Any OpenAI SDK caller (Codex CLI, Cline, OpenWebUI, `openai` for Python / JS, `curl`) — and any Gemini SDK caller — can consume your **subscription quota** (Claude Max, ChatGPT Plus/Pro) as if it were a plain vendor endpoint. The caller sees a normal request/response; behind Rialto the request goes to your OAuth-authenticated account, so cost stays inside your monthly subscription instead of hitting metered API billing.

### Endpoints (OpenAI wire shape)

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/v1/models`             | Returns the enabled, routable models as `{object:'list', data:[…]}`. Each `id` is the bare model name (round-trip it straight into the next call); `owned_by` is the provider Rialto will send it to. A name several providers host is listed only once Providers → Priorities orders them. Each entry also carries `provider`, the bare `model` name, `context_window` and `pricing` (USD per million tokens: input, output, cached input and both cache-write rates; `null` unless input and output are both known), so an app that bills its own users can price a call from this list. |
| `POST` | `/v1/chat/completions`   | Standard Chat Completions — stream + non-stream. Body's `model` field takes an `id` from `/v1/models`. A `provider,model` pair is still accepted from older clients. |
| `POST` | `/v1/responses`          | OpenAI Responses API — stream + non-stream. Same model addressing as above. |

Auth on these three paths is **`Authorization: Bearer <issued access token>` only** — `x-api-key` is an Anthropic convention and is rejected here, and 401 bodies follow OpenAI's `{error:{message,type,code}}` shape. The Anthropic surface (`/v1/messages`) additionally reads `x-api-key`, but the value must still be an issued access token.

### Example — OpenAI Python SDK against your Codex subscription

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="rialto_your-access-token",   # Access tokens screen
)

# 1. Discover routable models
for m in client.models.list().data:
    print(m.id)
# → gpt-5.5
# → claude-sonnet-5
# ...

# 2. Chat Completions (routed through your Codex Plus/Pro subscription)
res = client.chat.completions.create(
    model="gpt-5.5",
    messages=[{"role": "user", "content": "reply pong"}],
)
print(res.choices[0].message.content)  # → pong
```

### Example — OpenAI JS SDK

```ts
import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: 'http://localhost:3456/v1',
  apiKey: process.env.RIALTO_ACCESS_TOKEN, // Access tokens screen
})

const stream = await client.chat.completions.create({
  model: 'gpt-5.5',
  messages: [{ role: 'user', content: 'reply pong' }],
  stream: true,
})
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '')
```

Any client that supports overriding `base_url` / `baseURL` works the same way.

**What applies on these surfaces.** Failover, account rotation, model addressing by bare name, and Plan-gated model access all apply. The caller's `body.model` wins — Rialto does not reclassify a request to a different model. Persona injection does **not** apply — it is `/v1/messages` only (see Personas above).

## 🧩 Codex MCP server

`/codex` publishes your Codex subscription as an MCP server over Streamable HTTP, so Claude Code (CLI and Desktop) can ask Codex for a second opinion without a local `codex mcp-server`:

| Tool | What it does |
| --- | --- |
| `ask` | Ask Codex — code review, design critique, debugging. Pass the returned `thread_id` to continue the conversation. |
| `generate_image` | Generate an image with Codex's image models; returns the image and a 15-minute download link. |
| `status` | Each Codex account's 5-hour and weekly usage, and the models the tools can use. |

```shell
claude mcp add --transport http --scope user codex https://rialto.example.com/codex \
  --header "Authorization: Bearer <access token>"
```

The token must carry the **`/codex` scope explicitly** — an unscoped ("all endpoints") token does not reach it, because `status` reads out your Codex accounts. Calls are pinned to the Codex subscription and never fall back to another provider; Codex sees only what the prompt contains. Setup, the edge configuration and the details are in [docs/guides/codex-mcp.md](docs/guides/codex-mcp.md) (Japanese).

## 📊 Logging

One logger (pino) writes everything — HTTP requests, routing decisions, upstream calls, server events:

- **Console** — always, prettified.
- **Files** — `~/.rialto/logs/YYYY-MM-DD.log`, only while `LOG` is `true` (it defaults to `false`). A file that outgrows `LOG_MAX_MB` (default 10) continues in `YYYY-MM-DD-N.log`. Level is controlled by `LOG_LEVEL`; secrets (`authorization`, `x-api-key`, tokens, cookies) are redacted before writing.

The files are readable from **Activity → Logs** in the UI. There is no separate application log.

For Claude Code auto-mode troubleshooting, set `LOG=true` and `LOG_LEVEL=info`, then search the file or Activity → Logs for `classifier_diagnostic`. On `/v1/messages`, Rialto logs the presence of inbound `safeguards`, whether they survive the upstream transformation, a **suspected** legacy permission-gate prompt signature, the dispatched provider/model, and upstream HTTP status. Upstream JSON `safeguard_results` metadata is sampled only for small responses with a declared content length; streaming responses are not inspected. These events omit prompt text, tool arguments, safeguard decisions and credentials. `suspectedClassifier` is heuristic, not a guaranteed classifier marker. A Claude Code refusal made locally before any request reaches Rialto cannot be logged here, and an upstream status is not Claude Code's final auto-mode decision. Compare events with the same `reqId` for one upstream attempt; failovers get different IDs. Regular upstream error logs may already include raw error bodies, so handle log files as sensitive data.

## 🌐 Public deployment

Exposing Rialto through a tunnel needs `/api/*` and `/v1/*` treated differently — the first behind Cloudflare Access, the second bypassed at the edge and guarded by issued tokens alone. The full setup, and the failure modes that make CLI clients hang on a login page, are in [docs/guides/public-deployment.md](docs/guides/public-deployment.md) (Japanese).

**If you get locked out** (Access broken or misconfigured, `config.json` quarantined, Postgres down), there is no admin key to fall back on — and none is needed. SSH to the host, forward the port, and open `http://localhost:3456`:

```shell
ssh -L 3456:localhost:3456 <host>
```

A request made on the host is exempt from the admin gate, and that check reads neither Access nor the database. On Docker, publish the port on the host (loopback is enough) and do the same. The one setting that closes this door is `RIALTO_TRUST_LOCAL=false`.

## ⬆️ Upgrading

**v3 is a breaking change.** `routed` mode, scenarios, lanes, tiers, TierRoute, routing profiles and the Long-context tuner are gone. Every surface is passthrough, every Plan-gated token answers **403** for a model its Plan does not list (previously the request was rewritten to the Plan's `defaultModel`), and the old `routingMode` / `profileKey` columns were dropped. See [docs/guides/migration-v3.md](docs/guides/migration-v3.md) (Japanese).

## 🛠️ Development

### Prerequisites

- Bun ≥ 1.1.0
- PostgreSQL
- Redis

The devcontainer (`.devcontainer/compose.yaml`) provides `postgres` and `redis` automatically, and provisions the separate `rialto_test` database on a fresh volume.

### Setup

```shell
bun install
```

```shell
# .env
DATABASE_URL=postgres://postgres:password@postgres:5432/rialto
TEST_DATABASE_URL=postgres://postgres:password@postgres:5432/rialto_test
REDIS_URL=redis://redis:6379
```

```shell
bun run db:migrate
bun run dev         # Vite on port 16175: the SPA plus, via @hono/vite-dev-server,
                    # the Hono app for /api/*, /v1/*, /health and /callback
```

### Build

```shell
bun run build       # Vite production build (single-file output into dist/)
```

### Test

```shell
bun test                  # FULL suite
bun run test              # only __tests__/lib __tests__/db __tests__/preset
bun run test:providers    # provider contract tests (fixture replay)
bun run test:e2e          # browser tests against the already-running dev server;
                          # skips itself when :16175 is down or chromium is missing
bun run browser:install   # playwright's chromium, for test:e2e
```

`bun test` and `bun run test` are **not** the same command. CI (`.github/workflows/ci.yml`) runs five jobs: Commit Lint, Biome Check, Type Check, Test, Build.

### Checks

```shell
bunx tsc --noEmit         # CI runs `bunx tsc -b --noEmit`
bunx biome check --write .
bunx knip                 # dead-code inventory
```

### Database tooling

| Script | Purpose |
|--------|---------|
| `bun run db:generate` | Regenerate the Prisma client (also runs as `postinstall`) |
| `bun run db:migrate` | Create and apply a migration (development) |
| `bun run db:migrate:deploy` | Apply existing migrations (production / CI) |
| `bun run db:migrate:test` | Apply migrations to the separate `rialto_test` database |
| `bun run db:reset` | Drop and recreate the schema (destructive) |
| `bun run db:seed` | Idempotent seed — baseline inbound surfaces and reference rows the server needs on first boot |
| `bun run db:seed:demo` | Dev-only demo data for every screen; `-- --clean` removes it. See [docs/guides/demo-data.md](docs/guides/demo-data.md) |
| `bun run db:studio` | Open Prisma Studio |

Always go through Prisma migrations — never edit DDL directly. **After any migration, run `db:migrate:test` as well**, or CI will fail against the test database.

### Price scraping

| Script | Purpose |
|--------|---------|
| `bun run scrape:openai-prices` | Scrape OpenAI model pricing |
| `bun run scrape:anthropic-prices` | Scrape Anthropic model pricing |
| `bun run scrape:google-prices` | Scrape Google / Gemini pricing |
| `bun run scrape:prices` | Scrape all of the above |
| `bun run seed:prices-db` | Load the scraped prices into the database |

### Release

Tagging `v*.*.*` builds and publishes `ghcr.io/tkgstrator/rialto` for `linux/amd64` and `linux/arm64` (`.github/workflows/docker-publish.yml`). The scripts below are the manual path to the same image:

| Script | Purpose |
|--------|---------|
| `bun run release` | `bun run build`, then build and push the Docker image to GHCR |
| `bun run release:docker` | Build and push the Docker image only |

### Architecture documentation

- [`docs/architecture/inbound-surfaces.md`](docs/architecture/inbound-surfaces.md) — the surface registry and what derives from it
- [`docs/architecture/inbound-parity.md`](docs/architecture/inbound-parity.md) — which feature applies on which surface
- [`docs/architecture/routing.md`](docs/architecture/routing.md) — passthrough dispatch, Plan model check, failover and account rotation, the quota snapshot
- [`docs/architecture/pipeline-overview.md`](docs/architecture/pipeline-overview.md) — boot → request → upstream → response, end to end
- [`docs/architecture/request-flow.md`](docs/architecture/request-flow.md) — dispatch and 429 rotation, in detail
- [`docs/architecture/testing-map.md`](docs/architecture/testing-map.md) — where the tests are and what they cover
- [`docs/guides/pwa.md`](docs/guides/pwa.md) — installed-app / PWA behaviour

## License

MIT — see `LICENSE`.
