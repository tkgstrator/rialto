[![](https://img.shields.io/badge/🇬🇧-English-000aff?style=flat)](README.md)
[![](https://img.shields.io/badge/🇯🇵-日本語-bc002d?style=flat)](README_ja.md)
[![](https://img.shields.io/badge/🇨🇳-中文版-ff0000?style=flat)](README_zh.md)
[![Discord](https://img.shields.io/badge/Discord-%235865F2.svg?&logo=discord&logoColor=white)](https://discord.gg/rdftVMaUcS)
[![](https://img.shields.io/github/license/tkgstrator/rialto)](https://github.com/tkgstrator/rialto/blob/master/LICENSE)

<hr>

> A routing gateway for LLM traffic: it accepts four wire formats on the front door and dispatches each request to whichever vendor you configured — without changing your client's setup.

## ✨ Features

- **Four inbound surfaces** — Anthropic Messages (`/v1/messages`), OpenAI Chat Completions, OpenAI Responses, and Gemini `generateContent`. Everything a surface needs is one descriptor, so all four get the same auth, error envelopes, streaming and request history.
- **Chain routing** — an ordered `provider,model` chain per scenario (`default`, `think` (Plan Mode), `longContext`, `webSearch`, `image`) and per lane (`agent` / `subagent`). The selector walks it, skipping targets that are exhausted or switched off, and the rest of the chain is the failover list.
- **Passthrough** — or let the caller pick: a surface (or a single access token) in passthrough mode sends the caller's own `body.model` upstream untouched.
- **Failover with account rotation** — a 429 rotates to a peer subscription account first, then walks the rest of the chain. The chain's order is honoured as written, a subscription primary falling back to an api_key entry included.
- **Personas** — append a named system prompt to every `/v1/messages` request without touching Claude Code. Manage the library and pick the active one under Settings → Personas.
- **Multi-provider support** — connect API-key providers (Anthropic, OpenAI, DeepSeek, Gemini, Groq, OpenRouter, …) or subscription-based providers (Claude Code OAuth, OpenAI Codex).
- **Subscription monitoring** — track rate-limit windows and compare actual API spend against subscription cost.
- **Usage & cost dashboard** — per-provider and per-model cost breakdown with daily cost charts.
- **Request history** — browse past sessions with per-request stats and archived conversation transcripts.
- **Issued access tokens** — individually revocable, attributable per request, and scopeable to one surface and one routing profile.
- **Web management UI** — full browser-based configuration; no manual JSON editing required.
- **Transformer pipeline** — the chain is derived from the provider's API style and auth mode, so what the UI shows is what runs.
- **Status line** — real-time Rialto status display integrated into Claude Code's status bar.
- **Docker-first deployment** — single `docker compose up -d` with PostgreSQL and Redis included.

## 🖥️ Web UI

The web UI (served on port **3456** by default) gives you full control over every aspect of the gateway. It is organised as five screens:

| Screen | Route | Purpose |
|--------|-------|---------|
| **Overview** | `/overview` | Traffic, spend, and subscription-window health at a glance |
| **Routing** | `/routing` | The chain per scenario and lane, each surface's routing mode and profile, and the profile's constraints (including the `longContext` threshold) |
| **Providers** | `/providers` | Add, edit, or remove API-key and subscription providers; per-provider models, pricing, context windows, connectivity tests, and the read-only derived request shape |
| **Activity** | `/activity` | Sessions, per-request logs (`/activity/requests`), and server logs (`/activity/logs`) |
| **Settings** | `/settings` | Server, **Access** (issue `/v1/*` tokens), Logging, Personas, Status line, Advanced |

First run lands on `/setup`.

> Screenshots are being re-captured for the current interface; the ones under `docs/images/` show the retired pre-Rialto UI and have been removed from this page rather than left in place as a wrong picture of the product.

## 🚀 Quick Start with Docker (Recommended)

Install [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/), then:

**Step 1 — Create a working directory:**

```shell
mkdir -p ~/rialto ~/.rialto
cd ~/rialto
```

A config file is created for you on first boot. You only need to write one yourself if you want a break-glass admin key:

```shell
cat > ~/.rialto/config.json << 'EOF'
{
  "APIKEY": "your-secret-key"
}
EOF
```

> **`APIKEY` is optional and no longer generated for you.** A browser on the machine Rialto runs on is exempt from the admin gate, and remote admin access is meant to go through Cloudflare Access. Set `APIKEY` deliberately when you want a recovery path that survives an Access outage — it guards `/api/*` only.
>
> **It never authenticates `/v1/*`.** Clients call the proxy with an *access token* you issue under **Settings → Access** — individually revocable, attributable per request, and scopeable to one surface and routing profile. An install with no tokens issued cannot proxy.

**Step 2 — Download `compose.yaml`:**

```shell
curl -fsSL https://raw.githubusercontent.com/tkgstrator/rialto/master/compose.yaml -o compose.yaml
```

**Step 3 — (Optional) Store provider credentials in `.env`:**

```shell
cat > .env << 'EOF'
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AIza...
ANTHROPIC_API_KEY=sk-ant-...
EOF
```

**Step 4 — Start the services:**

```shell
docker compose up -d
```

The server starts at `http://127.0.0.1:3456`. Open that URL in a browser and use the **Providers** and **Routing** pages to finish configuration. Then issue an access token under **Settings → Access** — that is what your clients authenticate with.

**Step 5 — Point Claude Code at the gateway:**

```shell
ANTHROPIC_BASE_URL=http://127.0.0.1:3456 ANTHROPIC_AUTH_TOKEN=rialto_your-access-token claude
```

Or set permanently in your shell profile:

```shell
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
export ANTHROPIC_AUTH_TOKEN=rialto_your-access-token
```

**Step 6 — Turn routing on for the surface you use:**

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

On the **Providers** page, select any API-key provider (Anthropic, OpenAI, DeepSeek, Gemini, etc.), enter your API key, and save. Environment-variable interpolation (`$VAR`) is supported so you can keep secrets out of the config file.

### Subscription providers (Claude Code & Codex)

Rialto can route through subscription-based providers without a per-call API key.

**Claude Code** — Open the **Providers** page → **Subscription** tab → **Connect**, then complete the OAuth flow. Rialto stores and auto-refreshes the credentials.

**Codex (OpenAI)** — Browser-based login is not currently supported. Authentication is handled via credential file upload only.

> **Terms of service notice:** Using a Claude Code subscription to serve requests from applications other than Claude Code may violate [Anthropic's usage policies](https://www.anthropic.com/legal/aup). Use this feature at your own discretion and risk.

## 🚪 Inbound surfaces

Rialto is not only a Claude Code proxy. Four wire formats are accepted on the front door, and each one is described by a single descriptor in `src/llms/inbound/surfaces.ts`:

| Surface | Path | Typical client | Credential | Error envelope |
|---|---|---|---|---|
| `anthropic-messages` | `POST /v1/messages` | Claude Code | `x-api-key` or `Authorization: Bearer` | `{type:'error', error:{type,message}}` |
| `openai-chat` | `POST /v1/chat/completions` | OpenAI SDK, Cline, OpenWebUI | `Authorization: Bearer` | `{error:{message,type,code,param}}` |
| `openai-responses` | `POST /v1/responses` | Codex CLI | `Authorization: Bearer` | `{error:{message,type,code,param}}` |
| `gemini-generate` | `POST /v1beta/models/<model>:<action>` | Gemini CLI | `x-goog-api-key` or `?key=` | `{error:{code,message,status}}` |

`GET /v1/models` is a catalog read rather than a completion surface, so it is not one of the four — but its callers are OpenAI SDKs, so it answers in their credential convention and error envelope.

Whichever surface a request arrives on, the credential must be an **issued access token**. The envelope `APIKEY` is accepted on `/api/*` only.

### Routing mode

Each surface has one stored mode:

| Mode | Behaviour |
|---|---|
| `passthrough` | The caller picked the model. Scenario classification, the chain and proactive failover are all skipped. |
| `routed` | The chain runs: scenario classification → chain walk → failover. |

**Every surface starts in `passthrough`.** Routing an unconfigured install does nothing useful — with no chain the selector falls straight through to the caller's own model — so routing is something you switch on, per surface, once there is something to route to. Each surface can also be pinned to its own routing profile, which is how you fix, say, a CI client's surface on a cost-first chain. See [Chain and passthrough](#chain-and-passthrough) for what each mode does with `body.model`.

## ⚙️ Configuration

### Disk envelope (`~/.rialto/config.json`)

Boot-time scalars and disk-resident objects live here. Environment-variable interpolation (`$VAR` / `${VAR}`) and JSON5 comments are supported. The last three backups are kept automatically. Unknown keys are preserved, not dropped.

| Key | Description |
|-----|-------------|
| `APIKEY` | Optional break-glass secret for `/api/*`. Sent as `x-api-key` or `Authorization: Bearer`. Never accepted on `/v1/*`. Not generated for you |
| `HOST` | Listen address (default: `127.0.0.1`) |
| `PORT` | Listen port (default: `3456`) |
| `ACCESS_TEAM_DOMAIN` | Cloudflare Access team domain. With `ACCESS_AUD`, verifies the Access assertion on `/api/*` |
| `ACCESS_AUD` | Access application AUD tag. Both must be set — one alone enables nothing |
| `LOG` | `true` to enable log files |
| `LOG_LEVEL` | `fatal` / `error` / `warn` / `info` / `debug` / `trace` |
| `PROXY_URL` | HTTP proxy for upstream API requests |
| `API_TIMEOUT_MS` | Upstream API call timeout in ms. Also clamped into Bun's 1–255 s per-request idle timeout |
| `CLAUDE_PATH` | Path to the `claude` executable |
| `NON_INTERACTIVE_MODE` | Set `true` for Docker / CI environments to prevent stdin hangs |
| `CAPTURE_REQUESTS` | Record a `RequestLog` row per request (default `true`) |
| `CAPTURE_MESSAGES` | Archive conversation transcripts (default `true`) |
| `REDACT_TOOL_ARGUMENTS` | Strip tool-call arguments from the archive (default `false` — turning it on loses information that cannot be recovered later) |
| `ROUTING_SCHEDULER_INTERVAL_MS` | Scheduler tick, 60 000–3 600 000 (default `300000`) |
| `Personas` | The persona library (array) |
| `ActivePersona` | The active persona's uuid id; `null` / absent / empty means none. Also a top-level key on the `/api/config` wire |
| `StatusLine` | Status-line configuration object |

Keys an older build wrote for routing mechanisms that no longer exist — `Router`, `CUSTOM_ROUTER_PATH`, `LiveRoutingName`, `CROSS_PROVIDER_FALLBACK`, `ROUTER_MODE` — are ignored. `POST /api/config` drops them with a warning, and the next save removes them from the file.

### Providers, models and the chain (database)

Providers, models, the preference chains and each surface's routing mode live in PostgreSQL and are managed through the web UI (`POST /api/config`, `PUT /api/router-preferences`, `POST /api/inbound-surfaces`). The `Providers` key **inside** `config.json` is a one-way mirror written back from the database after each save — editing it by hand has no effect and is overwritten on the next write. Nothing about routing is mirrored to disk any more.

### Chain and passthrough

Those are the only two things Rialto does with `body.model`.

**Chain** (`routed`). The request is classified into a scenario and a lane, and the selector walks that lane's ordered `provider,model` chain from the profile the request resolves to — the access token's profile if it names one, otherwise the surface's, otherwise `live`. The first entry that is switched on, not exhausted and able to hold the request becomes `body.model`; the rest of the chain rides along as the failover list. Two things on the profile decide what happens when the walk finds nothing:

- `exhaustedBehavior` — the lane has entries but every one of them is gated out. `429` (the default) answers the client with a `rate_limit_error` and a `Retry-After` header without touching any upstream; `passthrough` sends the caller's own `body.model` instead, with no fallbacks.
- A lane with **no entries at all** never 429s, whatever `exhaustedBehavior` says: an unconfigured lane is "no opinion", and the caller's own model goes out as sent. The same happens if the chain cannot be loaded or routing fails for any other reason — Rialto never invents a target, it only ever replaces `body.model` with a chain entry.

**Passthrough** (`passthrough`, or an access token pinned to the reserved `passthrough` profile). The caller's `body.model` goes upstream as sent: `provider,model`, or a bare model name that exactly one enabled provider hosts. A surface can deny specific `provider,model` pairs in this mode.

Either way, a provider or model switched off on the Providers page is never dispatched — not from a chain entry, not from a passthrough request, not as a failover target, and not through a disabled subscription provider's accounts. Naming one by hand is refused rather than forwarded.

### Routing scenarios

Configure which model to use for each scenario on the **Routing** page:

| Scenario | When it is used |
|----------|----------------|
| `default` | All requests not matched by another scenario |
| `think` | The request opts into extended thinking (`thinking.type` is `enabled` or `adaptive`; an explicit `disabled` does *not* count) |
| `longContext` | Token count over the threshold, or a heavy effort/tier signal |
| `webSearch` | The request carries a `web_search*` tool |
| `image` | Image-related tasks |

There is **no `background` scenario.** It was folded into `default` by the `20260728_router_rules_drop_background` migration.

Each scenario has two lanes — `agent` for ordinary traffic and `subagent` for requests carrying a subagent tag — and each lane has its own ordered chain. A scenario is only chosen when its lane holds at least one usable entry; otherwise the request lands on `default`.

**The `longContext` threshold is not a fixed number.** A threshold set on the profile's constraints (Routing page) wins outright. With no configured value it is 70 % of the declared context window of the chain's first `default` / `agent` entry, leaving headroom for the reply. If neither resolves, it falls back to 128 000 tokens.

### Effort, tier, and fallbacks

Beyond the scenario triggers above, the router grades each request and walks an ordered fallback list:

- **Grading signals** — `output_config.effort` (`high`/`xhigh`/`max` → heavy → `longContext`; `low`/`medium` → explicitly light) and the requested model tier from `body.model` (opus → heavy). Tier is read only when effort is absent so older Claude Code traffic still grades correctly; an explicit low/medium effort suppresses the tier escalation so callers can downgrade an opus request.
- **Per-scenario fallback chains** — the router walks `[primary, ...fallbacks]` and picks the first candidate that is not marked exhausted and whose declared `contextWindow` can hold the request.
- **Capability gate** — fail-over never lands on a model whose declared `contextWindow` cannot hold the request. Models with no declared window are allowed (unknown = allow, conservative default).
- **Account rotation on 429** — for a subscription provider, a 429 marks that sub-account exhausted (until the real `resetAt`, or five minutes if the upstream did not say) and retries the same chain entry on a peer account, up to ten rotations. Only when no peer is left does the whole provider get marked and the walker move to the next chain entry.
- **Chain order is honoured as written** — there is no `auth_mode` gate. A subscription primary keeps the api_key fallbacks listed after it, and a same-provider fallback is walked too, because exhaustion is marked per `(provider, model)`. If you do not want a subscription to spill onto per-token billing, do not put the api_key entry after it.
- **Multi-account balancing** — with several enabled SubAccounts on the same provider, the session router drops accounts whose recorded hard-limit windows are already at 100 %, reuses the sticky session→account mapping when it still points at a survivor, and otherwise picks the account with the highest `remaining % ÷ time until reset` — the one most at risk of leaving quota unspent.

Decisions are logged structurally: a proactive drop logs `{ from, to, scenario, tokenCount, trace }`, and a dead-chain warning fires when every candidate is rejected so you can see what was tried and why. Each `trace` entry carries one of `kept` / `exhausted` / `capability` / `malformed`.

> **There is no weekly drain guard.** Earlier builds pre-empted a subscription provider once its weekly window crossed a linear drain target, tuned by a `Router.weeklyDrainMarginPct` knob. Both are gone. Subscription providers now run to their upstream limit and are rotated reactively on the 429 that actually happens, which is the signal that is never wrong.

### Personas

A *persona* is a named system-prompt fragment appended to every user-facing request after scenario routing. Use them to give Claude Code a consistent voice / role / set of working rules without editing Claude Code itself.

- **Library** — `Personas` is a top-level array on the disk envelope. Each entry has a stable uuid `id`, a free-form `name` (display label, need not be unique), and the `prompt` text. New installs ship with a small starter library; existing installs keep what they have on disk.
- **Active selection** — exactly one persona is active per install. Its uuid id is the top-level `ActivePersona` key, on the disk envelope and on the `/api/config` wire alike. `null` / absent / empty string means "no persona". There are no per-project or per-session override files.
- **Injection** — when the router resolves a scenario, the active persona's `prompt` is appended to the LAST system block carrying `cache_control` (falling back to the last string text block). This keeps the persona *inside* the cached prefix, so it consumes no extra cache breakpoint and stays byte-stable across requests (preserving Anthropic's prompt cache). String and undefined `system` values are concatenated; multi-block array systems are mutated in place.
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

`provider.transformer.use` is no longer read: a `use` block left over in an older config is dropped on load. The Providers page shows the derived chain read-only under **Request shape**, which is the first thing worth checking when a request misbehaves.

### Subagent routing

A subagent tag in the prompt routes that subagent onto the scenario's **`subagent` lane**:

```
<RIALTO-SUBAGENT-MODEL>subagent</RIALTO-SUBAGENT-MODEL>
Please help me analyze this code...
```

**Only the tag's presence matters — its contents are ignored.** The tag selects the lane; the model comes from that lane's configuration on the **Routing** page. This is deliberate: it makes subagent routing editable in one place instead of scattered across every subagent's prompt file. The tag is stripped before the request goes upstream, so the marker never reaches the vendor.

`<CCR-SUBAGENT-MODEL>` is the pre-rename spelling and is still accepted, because it lives in prompts people have already written. A tag whose body still names an old `provider,model` pair keeps working; the pair is simply not read.

## 🔀 OpenAI-compatible and Gemini-compatible API surfaces

Any OpenAI SDK caller (Codex CLI, Cline, OpenWebUI, `openai` for Python / JS, `curl`) — and any Gemini SDK caller — can consume your **subscription quota** (Claude Max, ChatGPT Plus/Pro) as if it were a plain vendor endpoint. The caller sees a normal request/response; behind Rialto the request goes to your OAuth-authenticated account, so cost stays inside your monthly subscription instead of hitting metered API billing.

### Endpoints (OpenAI wire shape)

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/v1/models`             | Returns the DB-backed enabled model list as `{object:'list', data:[…]}`. Each `id` is Rialto's canonical `provider,model` (round-trip it straight into the next call). |
| `POST` | `/v1/chat/completions`   | Standard Chat Completions — stream + non-stream. Body's `model` field takes the `provider,model` id from `/v1/models`. |
| `POST` | `/v1/responses`          | OpenAI Responses API — stream + non-stream. Same model addressing as above. |

Auth on these three paths is **`Authorization: Bearer <issued access token>` only** — `x-api-key` is an Anthropic convention and is rejected here, and 401 bodies follow OpenAI's `{error:{message,type,code}}` shape. The Anthropic surface (`/v1/messages`) additionally reads `x-api-key`, but the value must still be an issued access token.

### Example — OpenAI Python SDK against your Codex subscription

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="rialto_your-access-token",   # Settings → Access. NOT the APIKEY.
)

# 1. Discover routable models
for m in client.models.list().data:
    print(m.id, m.owned_by)
# → codex,gpt-5.6-luna  (owned_by=codex)
# → claude-code,claude-sonnet-5  (owned_by=claude-code)
# ...

# 2. Chat Completions (routed through your Codex Plus/Pro subscription)
res = client.chat.completions.create(
    model="codex,gpt-5.6-luna",
    messages=[{"role": "user", "content": "reply pong"}],
)
print(res.choices[0].message.content)  # → pong
```

### Example — OpenAI JS SDK

```ts
import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: 'http://localhost:3456/v1',
  apiKey: process.env.RIALTO_ACCESS_TOKEN, // Settings → Access
})

const stream = await client.chat.completions.create({
  model: 'codex,gpt-5.6-luna',
  messages: [{ role: 'user', content: 'reply pong' }],
  stream: true,
})
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '')
```

Any client that supports overriding `base_url` / `baseURL` works the same way.

**What applies on these surfaces.** Failover, account rotation, and the `provider,model` addressing always apply. Chain routing applies only once you switch the surface from `passthrough` to `routed`. Persona injection does **not** apply — it is `/v1/messages` only (see Personas above).

## 📊 Logging

- **Server-level logs** (pino): `~/.rialto/logs/rialto-*.log` — HTTP requests, API calls, server events. Level controlled by `LOG_LEVEL`.
- **Application-level logs**: `~/.rialto/rialto.log` — routing decisions and business-logic events.

Both are readable from **Activity → Logs** in the UI.

## 🌐 Public deployment

Exposing Rialto through a tunnel needs `/api/*` and `/v1/*` treated differently — the first behind Cloudflare Access, the second bypassed at the edge and guarded by issued tokens alone. The full setup, and the failure modes that make CLI clients hang on a login page, are in [docs/guides/public-deployment.md](docs/guides/public-deployment.md).

## ⬆️ Upgrading from the pre-rename build

Home directory, environment variables, database names, Docker image and thinking-signature prefixes all changed with the rename to Rialto. See [docs/guides/migration-v3.md](docs/guides/migration-v3.md).

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
```

`bun test` and `bun run test` are **not** the same command. CI runs three gates: Build, Type Check, Test.

### Checks

```shell
bunx tsc --noEmit
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
| `bun run db:seed` | Idempotent seed — the `live` preference profile |
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

| Script | Purpose |
|--------|---------|
| `bun run release` | Build and publish the Docker image |
| `bun run release:docker` | Publish Docker image only |

### Architecture documentation

- [`docs/architecture/inbound-surfaces.md`](docs/architecture/inbound-surfaces.md) — the surface registry and what derives from it
- [`docs/architecture/pipeline-overview.md`](docs/architecture/pipeline-overview.md) — boot → request → upstream → response, end to end
- [`docs/architecture/request-flow.md`](docs/architecture/request-flow.md) — routing decisions and 429 rotation, in detail
- [`docs/architecture/testing-map.md`](docs/architecture/testing-map.md) — where the tests are and what they cover

## License

MIT — see `LICENSE`.
