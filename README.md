[![](https://img.shields.io/badge/🇬🇧-English-000aff?style=flat)](README.md)
[![](https://img.shields.io/badge/🇯🇵-日本語-bc002d?style=flat)](README_ja.md)
[![](https://img.shields.io/badge/🇨🇳-中文版-ff0000?style=flat)](README_zh.md)
[![Discord](https://img.shields.io/badge/Discord-%235865F2.svg?&logo=discord&logoColor=white)](https://discord.gg/rdftVMaUcS)
[![](https://img.shields.io/github/license/tkgstrator/rialto)](https://github.com/tkgstrator/rialto/blob/master/LICENSE)

<hr>

> A routing gateway for LLM traffic: it accepts four wire formats on the front door and dispatches each request to whichever vendor you configured — without changing your client's setup.

## ✨ Features

- **Four inbound surfaces** — Anthropic Messages (`/v1/messages`), OpenAI Chat Completions, OpenAI Responses, and Gemini `generateContent`. Everything a surface needs is one descriptor, so all four get the same auth, error envelopes, streaming and request history.
- **Chain routing** — an ordered `provider,model` chain per scenario (`default`, `think` (Plan Mode), `longContext`, `webSearch`) and per lane (`agent` / `subagent`). The selector walks it, skipping targets that are exhausted or switched off, and the rest of the chain is the failover list.
- **Passthrough** — or let the caller pick: a surface (or a single access token) in passthrough mode sends the caller's own `body.model` upstream untouched.
- **Failover with account rotation** — a 429 rotates to a peer subscription account first, then walks the rest of the chain. The chain's order is honoured as written, a subscription primary falling back to an api_key entry included.
- **Personas** — append a named system prompt to every routed `/v1/messages` request without touching Claude Code. Manage the library and pick the active one under Settings → Personas.
- **Multi-provider support** — connect API-key providers (Anthropic, OpenAI, DeepSeek, Gemini, Groq, OpenRouter, …) or subscription-based providers (Claude Code OAuth, OpenAI Codex), with several accounts per subscription provider.
- **Subscription monitoring** — each account's rate-limit windows, refreshed on demand from the Subscriptions list, and the exhaustion state the router reads.
- **Usage & cost** — spend for today, this week and this month on Overview; per-provider cost by day or week, and per-account subscription usage, under Activity → Usage.
- **Request history** — browse past sessions with per-request stats and archived conversation transcripts.
- **Issued access tokens** — individually revocable and rotatable, attributable per request, and scopeable to a set of surfaces and one routing profile.
- **Web management UI** — full browser-based configuration in English, Japanese or Chinese; no manual JSON editing required.
- **Transformer pipeline** — the chain is derived from the provider's API style and auth mode, so what the UI shows is what runs.
- **Docker-first deployment** — single `docker compose up -d` with PostgreSQL and Redis included.

## 🖥️ Web UI

The web UI (served on port **3456** by default) gives you full control over every aspect of the gateway. It is organised as six screens:

| Screen | Route | Purpose |
|--------|-------|---------|
| **Overview** | `/overview` | Spend, subscription quota windows, and requests / errors per inbound surface at a glance |
| **Routing** | `/routing` | Each surface's routing mode and profile, the chain per scenario and lane, the profile's constraints, and the targets a passthrough surface may name |
| **Providers** | `/providers` | Two lists — `/providers/subscriptions` and `/providers/api-keys` — plus `/providers/connect` to add one and `/providers/<name>` for models, prices, context windows, connectivity tests and the read-only derived request shape |
| **Access tokens** | `/access-tokens` | Issue, scope, rotate and revoke the tokens clients use on `/v1/*` |
| **Activity** | `/activity` | Sessions, per-request logs (`/activity/requests`), subscription usage (`/activity/usage`), and server logs (`/activity/logs`) |
| **Settings** | `/settings` | Server, Access (admin access: Cloudflare Access, and how to get back in if it breaks), Logging, Personas, Status line, Advanced (config document, health) |

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
> **`/v1/*` takes access tokens only.** Clients call the proxy with an *access token* you issue under **Access tokens** — individually revocable, attributable per request, and scopeable to surfaces and a routing profile. An install with no tokens issued cannot proxy.

**Step 2 — Start the services:**

```shell
docker compose up -d
```

The entrypoint applies pending Prisma migrations and the seed before the server starts. The server then listens at `http://127.0.0.1:3456`. Open that URL in a browser and use the **Providers** and **Routing** pages to finish configuration. Then issue a token under **Access tokens** — that is what your clients authenticate with.

**Step 3 — Point Claude Code at the gateway:**

```shell
ANTHROPIC_BASE_URL=http://127.0.0.1:3456 ANTHROPIC_AUTH_TOKEN=rialto_your-access-token claude
```

Or set permanently in your shell profile:

```shell
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
export ANTHROPIC_AUTH_TOKEN=rialto_your-access-token
```

**Step 4 — Turn routing on for the surface you use:**

Every surface ships in `passthrough` mode, where the caller's own `body.model` is used verbatim. Switch `/v1/messages` (or whichever surface you point at) to `routed` on the **Routing** page once you have something to route to. See [Inbound surfaces](#-inbound-surfaces) below.

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

On the **Providers** page, choose **Add provider**, pick a vendor (Anthropic, OpenAI, DeepSeek, Gemini, etc.), paste your API key, and choose which models to enable. The key is stored in the database, not in `config.json`; only the models switched on here can be routed to, and the rest stay listed so you can enable them later.

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

Rialto stores the encrypted tokens and refreshes them. A provider may hold several accounts; which one serves a request is decided per request (see [Effort, tier, and fallbacks](#effort-tier-and-fallbacks)). The Subscriptions list has a **Refresh** button (`POST /api/subscriptions/refresh`) that re-syncs every account on an enabled subscription provider and re-polls its usage past the 5-minute cache.

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

### Routing mode

Each surface has one stored mode:

| Mode | Behaviour |
|---|---|
| `passthrough` | The caller picked the model. Scenario classification, the chain and proactive failover are all skipped. |
| `routed` | The chain runs: scenario classification → chain walk → failover. |

**Every surface starts in `passthrough`.** Routing an unconfigured install does nothing useful — with no chain the selector falls straight through to the caller's own model — so routing is something you switch on, per surface, once there is something to route to. Each surface also draws from a routing profile (`live` by default); the Routing page's profile picker lets you point, say, a CI client's surface at a cost-first chain. A second profile is created by writing to it: `PUT /api/router-preferences?profile=<key>`. See [Chain and passthrough](#chain-and-passthrough) for what each mode does with `body.model`.

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
| `StatusLine` | The status-line layout edited under Settings → Status line. Preview only: nothing in this build renders it |

The scalar keys above (everything but `Personas`, `ActivePersona` and `StatusLine`) can also be supplied as process environment variables — a Docker `environment:` entry, for instance — and a set environment value wins over the file.

Keys an older build wrote for mechanisms that no longer exist are ignored. `Router`, `CUSTOM_ROUTER_PATH`, `LiveRoutingName`, `CROSS_PROVIDER_FALLBACK` and the retired admin key `APIKEY` are stripped on every read; `POST /api/config` drops them with a warning, and the next save removes them from the file. An `APIKEY` environment variable is not read either. `ROUTER_MODE` merely survives as an unknown key and is read by nothing.

### Providers, models and the chain (database)

Providers, models, the preference chains and each surface's routing mode live in PostgreSQL and are managed through the web UI (`POST /api/config`, `PUT /api/router-preferences`, `POST /api/inbound-surfaces`). The `Providers` key **inside** `config.json` is a one-way mirror written back from the database after each save — editing it by hand has no effect and is overwritten on the next write. Nothing about routing is mirrored to disk any more.

### Chain and passthrough

Those are the only two things Rialto does with `body.model`.

**Chain** (`routed`). The request is classified into a scenario and a lane, and the selector walks that lane's ordered `provider,model` chain from the profile the request resolves to — the access token's profile if it names one, otherwise the surface's, otherwise `live`. The first entry that is switched on, not exhausted and able to hold the request becomes `body.model`; the rest of the chain rides along as the failover list. Two things on the profile decide what happens when the walk finds nothing:

- `exhaustedBehavior` — the lane has entries but every one of them is gated out. `429` (the default) answers the client with a `rate_limit_error` and a `Retry-After` header (seconds until the earliest window reset, or 30 when none is known) without touching any upstream; `passthrough` sends the caller's own `body.model` instead, with no fallbacks.
- A lane with **no entries at all** never 429s, whatever `exhaustedBehavior` says: an unconfigured lane is "no opinion", and the caller's own model goes out as sent. The same happens if the chain cannot be loaded or routing fails for any other reason — Rialto never invents a target, it only ever replaces `body.model` with a chain entry.

**Passthrough** (`passthrough`, or an access token pinned to the reserved `passthrough` profile). The caller's `body.model` goes upstream as sent: `provider,model`, or a bare model name that exactly one enabled provider hosts. A surface can deny specific `provider,model` pairs in this mode (Routing → Reachable targets).

Either way, a provider or model switched off on the Providers page is never dispatched — not from a chain entry, not from a passthrough request, not as a failover target, and not through a disabled subscription provider's accounts. Naming one by hand is refused rather than forwarded.

### Routing scenarios

Configure the chain for each scenario on the **Routing** page. Classification runs in this order and stops at the first match:

| Scenario | When it is used |
|----------|----------------|
| `longContext` | Token count over the threshold; or, checked after the two below, a heavy effort / tier signal |
| `webSearch` | The request carries a web-search tool: a tool whose `type` starts with `web_search`, a function named `web_search*`, or top-level `web_search_options` |
| `think` | The request opts into extended thinking (`thinking.type` is `enabled` or `adaptive`; an explicit `disabled` does *not* count) |
| `default` | Everything else |

An `image` scenario also exists in the chain editor, but nothing classifies a request into it in this build — a chain configured there is never selected. There is **no `background` scenario.** It was folded into `default` by the `20260728_router_rules_drop_background` migration.

Each scenario has two lanes — `agent` for ordinary traffic and `subagent` for requests carrying a subagent tag — and each lane has its own ordered chain. A scenario is only chosen when its lane holds at least one enabled entry; otherwise the request lands on `default`.

**The `longContext` threshold is not a fixed number.** A positive `longContextThreshold` in the profile's constraints wins outright — it round-trips through `PUT /api/router-preferences`; the Routing page has no field for it in this build. With no configured value it is 70 % of the declared context window of the chain's first enabled `default` / `agent` entry, leaving headroom for the reply. If neither resolves, it falls back to 128 000 tokens.

### Effort, tier, and fallbacks

Beyond the scenario triggers above, the router grades each request and walks an ordered fallback list:

- **Grading signals** — `output_config.effort` (`high` / `xhigh` / `max` → heavy → `longContext`; `low` / `medium` → explicitly light) and the requested model tier from `body.model` (a name containing `opus` → heavy). Tier is read only when effort is absent so older Claude Code traffic still grades correctly; an explicit low/medium effort suppresses the tier escalation so callers can downgrade an opus request.
- **Per-scenario fallback chains** — the router walks `[primary, ...fallbacks]` and picks the first candidate that is not marked exhausted and whose declared `contextWindow` can hold the request.
- **Capability gate** — fail-over never lands on a model whose declared `contextWindow` cannot hold the request. Models with no declared window are allowed (unknown = allow, conservative default).
- **Account rotation on 429** — for a subscription provider, a 429 marks that sub-account exhausted (until the reset of a binding window that is at least 90 % full, or five minutes if none is known) and retries the same chain entry on a peer account, up to ten rotations. Only when no peer is left does the model get marked and the walker move to the next chain entry. OpenAI's `insufficient_quota` marks the whole provider at once.
- **Chain order is honoured as written** — there is no `auth_mode` gate. A subscription primary keeps the api_key fallbacks listed after it, and a same-provider fallback is walked too, because exhaustion is marked per `(provider, model)`. If you do not want a subscription to spill onto per-token billing, do not put the api_key entry after it.
- **Multi-account balancing** — with several enabled accounts on the same provider, the account picker drops accounts whose recorded binding windows are already at 99 %, reuses the sticky session→account mapping when it still points at a survivor, and otherwise picks the account with the highest required burn rate — `remaining % ÷ hours until reset`, taken over its tightest binding weekly window — i.e. the one most at risk of leaving quota unspent. Ties go to the least recently picked account.

Decisions are logged structurally: a proactive drop logs `{ from, to, scenario, tokenCount, trace }`, and a dead-chain warning fires when every candidate is rejected so you can see what was tried and why. Each `trace` entry carries one of `kept` / `exhausted` / `capability` / `malformed`.

> **There is no weekly drain guard.** Earlier builds pre-empted a subscription provider once its weekly window crossed a linear drain target. That is gone: subscription providers run to their upstream limit and are rotated reactively on the 429 that actually happens, which is the signal that is never wrong.

### Personas

A *persona* is a named system-prompt fragment appended to every routed `/v1/messages` request after scenario routing. Use them to give Claude Code a consistent voice / role / set of working rules without editing Claude Code itself.

- **Library** — `Personas` is a top-level array on the disk envelope. Each entry has a stable uuid `id`, a free-form `name` (display label, need not be unique), and the `prompt` text. New installs ship with a small starter library; existing installs keep what they have on disk.
- **Active selection** — at most one persona is active per install. Its uuid id is the top-level `ActivePersona` key, on the disk envelope and on the `/api/config` wire alike. `null` / absent / empty string means "no persona". There are no per-project or per-session override files.
- **Injection** — the active persona's `prompt` is appended to the LAST system block carrying `cache_control` (falling back to the last string text block). This keeps the persona *inside* the cached prefix, so it consumes no extra cache breakpoint and stays byte-stable across requests (preserving Anthropic's prompt cache). String and undefined `system` values are concatenated; multi-block array systems are mutated in place.
- **Surface restriction** — persona injection runs on **`/v1/messages` only**, and only on routed traffic: a passthrough surface, or a token pinned to the `passthrough` profile, skips the router and the persona with it. The OpenAI-compat and Gemini surfaces reject an enriched `system` field outright (Codex answers `Unsupported parameter: system`), so the enrichment is skipped there rather than breaking the request. Every scenario on `/v1/messages` inherits the active persona — there is no per-scenario exclusion.
- **Subagent interaction** — persona injection runs *after* subagent-tag handling, so a subagent's per-call system content composes with — rather than clobbers — the persona.

Both the library and the active selection live under **Settings → Personas** (`/settings/personas`). "No persona" is the no-op default.

For authoring high-fidelity personas (structural patterns, anti-pattern cataloguing, thought-process control for `think` requests), see [docs/guides/persona-authoring.md](docs/guides/persona-authoring.md).

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

### Subagent routing

A subagent tag in the prompt routes that subagent onto the scenario's **`subagent` lane**:

```
<RIALTO-SUBAGENT-MODEL>subagent</RIALTO-SUBAGENT-MODEL>
Please help me analyze this code...
```

**Only the tag's presence matters — its contents are ignored.** The tag selects the lane; the model comes from that lane's configuration on the **Routing** page. This is deliberate: it makes subagent routing editable in one place instead of scattered across every subagent's prompt file. The tag is stripped before the request goes upstream, so the marker never reaches the vendor. A subagent lane with no entries behaves like any empty lane: the caller's own model passes through.

`<CCR-SUBAGENT-MODEL>` is the pre-rename spelling and is still accepted, because it lives in prompts people have already written. A tag whose body still names an old `provider,model` pair keeps working; the pair is simply not read.

## 🔀 OpenAI-compatible and Gemini-compatible API surfaces

Any OpenAI SDK caller (Codex CLI, Cline, OpenWebUI, `openai` for Python / JS, `curl`) — and any Gemini SDK caller — can consume your **subscription quota** (Claude Max, ChatGPT Plus/Pro) as if it were a plain vendor endpoint. The caller sees a normal request/response; behind Rialto the request goes to your OAuth-authenticated account, so cost stays inside your monthly subscription instead of hitting metered API billing.

### Endpoints (OpenAI wire shape)

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/v1/models`             | Returns the enabled, routable models as `{object:'list', data:[…]}`. Each `id` is Rialto's canonical `provider,model` (round-trip it straight into the next call); `owned_by` is the provider name. |
| `POST` | `/v1/chat/completions`   | Standard Chat Completions — stream + non-stream. Body's `model` field takes the `provider,model` id from `/v1/models`. |
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
    print(m.id, m.owned_by)
# → codex,gpt-5.5  (owned_by=codex)
# → claude-code,claude-sonnet-5  (owned_by=claude-code)
# ...

# 2. Chat Completions (routed through your Codex Plus/Pro subscription)
res = client.chat.completions.create(
    model="codex,gpt-5.5",
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
  model: 'codex,gpt-5.5',
  messages: [{ role: 'user', content: 'reply pong' }],
  stream: true,
})
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '')
```

Any client that supports overriding `base_url` / `baseURL` works the same way.

**What applies on these surfaces.** Failover, account rotation, and the `provider,model` addressing always apply. Chain routing applies only once you switch the surface from `passthrough` to `routed`. Persona injection does **not** apply — it is `/v1/messages` only (see Personas above).

## 📊 Logging

One logger (pino) writes everything — HTTP requests, routing decisions, upstream calls, server events:

- **Console** — always, prettified.
- **Files** — `~/.rialto/logs/rialto-YYYY-MM-DD.log`, only while `LOG` is `true` (it defaults to `false`). A file that outgrows `LOG_MAX_MB` (default 10) continues in `rialto-YYYY-MM-DD-N.log`. Level is controlled by `LOG_LEVEL`; secrets (`authorization`, `x-api-key`, tokens, cookies) are redacted before writing.

The files are readable from **Activity → Logs** in the UI. There is no separate application log.

## 🌐 Public deployment

Exposing Rialto through a tunnel needs `/api/*` and `/v1/*` treated differently — the first behind Cloudflare Access, the second bypassed at the edge and guarded by issued tokens alone. The full setup, and the failure modes that make CLI clients hang on a login page, are in [docs/guides/public-deployment.md](docs/guides/public-deployment.md) (Japanese).

**If you get locked out** (Access broken or misconfigured, `config.json` quarantined, Postgres down), there is no admin key to fall back on — and none is needed. SSH to the host, forward the port, and open `http://localhost:3456`:

```shell
ssh -L 3456:localhost:3456 <host>
```

A request made on the host is exempt from the admin gate, and that check reads neither Access nor the database. On Docker, publish the port on the host (loopback is enough) and do the same. The one setting that closes this door is `RIALTO_TRUST_LOCAL=false`.

## ⬆️ Upgrading from the pre-rename build

Home directory, environment variables, database names, Docker image and thinking-signature prefixes all changed with the rename to Rialto, and the slot / rules / preset routing of earlier builds collapsed into chain and passthrough. See [docs/guides/migration-v3.md](docs/guides/migration-v3.md) (Japanese).

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
| `bun run db:seed` | Idempotent seed — the `live` preference profile, empty until you fill it in |
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
- [`docs/architecture/pipeline-overview.md`](docs/architecture/pipeline-overview.md) — boot → request → upstream → response, end to end
- [`docs/architecture/request-flow.md`](docs/architecture/request-flow.md) — routing decisions and 429 rotation, in detail
- [`docs/architecture/testing-map.md`](docs/architecture/testing-map.md) — where the tests are and what they cover
- [`docs/guides/pwa.md`](docs/guides/pwa.md) — installed-app / PWA behaviour

## License

MIT — see `LICENSE`.
