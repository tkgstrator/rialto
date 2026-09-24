[![](https://img.shields.io/badge/🇬🇧-English-000aff?style=flat)](README.md)
[![](https://img.shields.io/badge/🇯🇵-日本語-bc002d?style=flat)](README_ja.md)
[![](https://img.shields.io/badge/🇨🇳-中文版-ff0000?style=flat)](README_zh.md)
[![Discord](https://img.shields.io/badge/Discord-%235865F2.svg?&logo=discord&logoColor=white)](https://discord.gg/rdftVMaUcS)
[![](https://img.shields.io/github/license/tkgstrator/rialto)](https://github.com/tkgstrator/rialto/blob/master/LICENSE)

<hr>

> A routing gateway for LLM traffic: it accepts four wire formats on the front door and dispatches each request to whichever vendor you configured — without changing your client's setup.

## ✨ Features

- **Four inbound surfaces** — Anthropic Messages (`/v1/messages`), OpenAI Chat Completions, OpenAI Responses, and Gemini `generateContent`. Everything a surface needs is one descriptor, so all four get the same auth, error envelopes, streaming and request history.
- **Tier routing** — a tier map per profile: the tier the caller asked for, read off the model name (`fable` / `opus` / `sonnet` / `haiku`, or `other`), maps to an ordered list of routes, each naming a provider and a tier on it. Which model that is comes from the provider's *tier alias*, so a new model release moves one alias instead of every route. The first route that can take the request serves it; the rest are the failover list.
- **Passthrough** — or let the caller pick: a surface (or a single access token) in passthrough mode sends the caller's own `body.model` upstream untouched.
- **Failover with account rotation** — a 429 rotates to a peer subscription account first, then walks the rest of the tier's routes. The map's order is honoured as written, a subscription route falling back to an api_key route included.
- **Personas** — append a named system prompt to every routed `/v1/messages` request without touching Claude Code. Manage the library and pick the active one under Settings → Personas.
- **Multi-provider support** — connect API-key providers (Anthropic, OpenAI, DeepSeek, Gemini, Groq, OpenRouter, …) or subscription-based providers (Claude Code OAuth, OpenAI Codex), with several accounts per subscription provider.
- **Subscription monitoring** — each account's rate-limit windows, refreshed on demand from the Subscriptions list, and the exhaustion state the router reads. A refresh reaches routing at once, and a Codex account's banked rate-limit resets can be spent from its provider page.
- **Usage & cost** — spend for today, this week and this month on Overview; per-provider cost by day or week, and per-account subscription usage, under Activity → Usage. Overview and each subscription provider's page also show, per account, what its traffic would have cost at API prices — this week and over 30 days.
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
| **Routing** | `/routing` | Each surface's routing mode and profile, the profile's tier map (the routes per requested tier, the model each one reaches today, and its quota state), the profile's constraints, and the targets a passthrough surface may name |
| **Providers** | `/providers` | Two lists — `/providers/subscriptions` and `/providers/api-keys` — plus `/providers/connect` to add one and `/providers/<name>` for tier aliases, models, prices, context windows, connectivity tests and the read-only derived request shape |
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

### Routing mode

Each surface has one stored mode:

| Mode | Behaviour |
|---|---|
| `passthrough` | The caller picked the model. The tier map is skipped. |
| `routed` | The tier map runs: requested tier → the first route that passes every gate → failover. |

**Every surface starts in `passthrough`.** Routing an unconfigured install does nothing useful — with an empty tier map every request falls straight through to the caller's own model — so routing is something you switch on, per surface, once there is something to route to. Each surface also draws from a routing profile (`live` by default); the Routing page's profile picker lets you point, say, a CI client's surface at a cost-first map. A second profile is created by writing to it: `PUT /api/routing/profiles/<key>`. See [Tier map and passthrough](#tier-map-and-passthrough) for what each mode does with `body.model`.

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

### Providers, models and the tier map (database)

Providers, models, tier aliases, each profile's tier map and each surface's routing mode live in PostgreSQL and are managed through the web UI (`POST /api/config`, `PUT /api/providers/{name}/tier-aliases/{tier}`, `PUT /api/routing/profiles/{key}`, `POST /api/inbound-surfaces`). The `Providers` key **inside** `config.json` is a one-way mirror written back from the database after each save — editing it by hand has no effect and is overwritten on the next write. Nothing about routing is mirrored to disk any more.

### Tier map and passthrough

Those are the only two things Rialto does with `body.model`.

**Tier map** (`routed`). The request routes through a profile — the access token's profile if it names one, otherwise the surface's, otherwise `live`. Its *requested tier* is read off `body.model`: a name containing `fable`, `opus`, `sonnet` or `haiku` (checked in that order) asks for that tier, and anything else — `gpt-5.5`, `gemini-2.5-pro`, a custom id — asks for `other`. The profile lists an ordered set of routes for each of the five, and each route names a provider and a tier on it (`claude-code · sonnet`); the provider's [tier alias](#tier-aliases) says which model that is today. Serving a Haiku request with Sonnet is simply a route in the `haiku` group that names a provider's `sonnet` — a substitution is written in the map, not decided by a gate.

The routes are tried in order, and a route serves only if it passes every gate:

1. the route, its model and its provider are all switched on;
2. the provider has an alias for the tier the route names;
3. if the request carries a web-search tool, the model can run it — the Anthropic, OpenAI Responses and Gemini request shapes carry it across, Chat Completions cannot;
4. the model's context window holds the prompt (an unknown window is allowed);
5. it is not out of quota: no exhaustion mark from an earlier 429 on that model or its provider, and the routing scheduler's snapshot does not report it spent, or used at or past the profile's `quotaSkipPct` (only subscription targets have a reading);
6. its error rate over the last five minutes is under `errorRateSkipPct`, once it has at least `minHealthSamples` samples.

The first route that passes becomes `body.model`; the others that pass ride along, in map order, as the failover list. When none passes, the reason decides the answer:

| Situation | Answer |
|---|---|
| The tier has no routes, or every route or its target is switched off | The caller's own `body.model` goes out as sent. **Never a 429**, whatever `exhaustedBehavior` says: an unconfigured tier is "no opinion" |
| At least one route was held back by quota or error rate | `exhaustedBehavior`: `429` (the default) answers `rate_limit_error` with a `Retry-After` header — seconds until the first held-back route can serve again (its 429 mark's deadline, else its reset in the snapshot; 30 when neither is known) — without touching any upstream; `passthrough` sends the caller's own `body.model` instead, with no fallbacks |
| Nothing was held back on quota, but the routes cannot take *this* request — alias unset, no web search, prompt too big | **400** in the surface's error envelope (`invalid_request_error`, or `INVALID_ARGUMENT` on the Gemini surface). Waiting would not change it, so it is not dressed up as a 429 |

If the map cannot be loaded or routing fails for any other reason, the caller's own model goes out as sent. Rialto never invents a target: it only ever replaces `body.model` with a route's model.

The profile carries four constraints, edited on the Routing page: `exhaustedBehavior` (`429` / `passthrough`), `quotaSkipPct` (default 100), `errorRateSkipPct` (a fraction, default 0.5) and `minHealthSamples` (default 5). There is nothing else to tune — no scenarios, lanes, long-context threshold or weights.

**Passthrough** (`passthrough`, or an access token pinned to the reserved `passthrough` profile). The caller's `body.model` goes upstream as sent: `provider,model`, or a bare model name that exactly one enabled provider hosts. A surface can deny specific `provider,model` pairs in this mode (Routing → Reachable targets).

Either way, a provider or model switched off on the Providers page is never dispatched — not from a route, not from a passthrough request, not as a failover target, and not through a disabled subscription provider's accounts. Naming one by hand is refused rather than forwarded.

The route a request took is recorded on its request log — the requested tier, or `passthrough` — and shown as **Route** under Activity. The full reference is [docs/architecture/routing.md](docs/architecture/routing.md).

### Tier aliases

A route names a provider and a tier, never a model. Which model `claude-code · sonnet` means is that provider's *tier alias*, set in the **Tier aliases** strip on the provider's page — one slot each for `fable`, `opus`, `sonnet` and `haiku`. When a vendor ships a new Sonnet, you move that one alias and every route that names the provider's Sonnet follows it.

**An alias never moves by itself.** A catalog Refresh can discover the new model, and the strip then counts it as a candidate ("1 new"), but a new model's price, entitlement and behaviour are for you to look at before every Sonnet request lands on it. Choosing it in the picker and saving the page points the alias at it and switches the model on. The picker offers every model the provider lists, not only the ones whose name says the tier, so a provider whose model names say no Claude family — Codex, OpenAI — can be aliased too.

A Claude subscription provider gets its aliases from its preset's default models as soon as its models are created, so a freshly connected Claude subscription routes without a trip to the strip. Codex's model names say no Claude family, so its aliases are yours to set.

A route whose alias is unset is kept (saving the map only warns) and skipped at request time. If that leaves the tier with nothing that can serve and no route was held back on quota, the request is refused with a 400, as above.

### Failover and account rotation

The tier's routes are the failover list; within one route, a subscription provider's accounts are rotated first:

- **Account rotation on 429** — for a subscription provider, a 429 marks that sub-account exhausted (until the reset of a binding window that is at least 90 % full, or five minutes if none is known) and retries the same target on a peer account, up to ten rotations. Only when no peer is left does the model get marked and the walker move to the next route. OpenAI's `insufficient_quota` marks the whole provider at once. A later success on the account lifts its mark.
- **The map's order is honoured as written** — there is no `auth_mode` gate. A subscription route keeps the api_key routes listed after it, and another tier of the same provider is walked too, because exhaustion is marked per `(provider, model)`. If you do not want a subscription to spill onto per-token billing, do not put the api_key route after it.
- **Multi-account balancing** — with several enabled accounts on the same provider, the account picker drops accounts whose recorded binding windows are already at 99 %, reuses the sticky session→account mapping when it still points at a survivor, and otherwise picks the account with the highest required burn rate — `remaining % ÷ hours until reset`, taken over its tightest binding weekly window — i.e. the one most at risk of leaving quota unspent. Ties go to the least recently picked account.

Decisions are logged structurally. When a tier has no usable route, the log lists each skipped route with its reason — `disabled` / `alias_unset` / `no_web_search` / `context_too_small` / `exhausted` / `error_rate` — at `warn` when the answer is a 429 or a 400, and at `info` when the caller's own model goes out.

> **There is no weekly drain guard.** Earlier builds pre-empted a subscription provider once its weekly window crossed a linear drain target. That is gone: a subscription target is held back only when the scheduler's snapshot says it is spent — or used at or past `quotaSkipPct`, which defaults to 100 — and otherwise runs to its upstream limit and is rotated on the 429 that actually happens.

### Personas

A *persona* is a named system-prompt fragment appended to every routed `/v1/messages` request after tier routing. Use them to give Claude Code a consistent voice / role / set of working rules without editing Claude Code itself.

- **Library** — `Personas` is a top-level array on the disk envelope. Each entry has a stable uuid `id`, a free-form `name` (display label, need not be unique), and the `prompt` text. New installs ship with a small starter library; existing installs keep what they have on disk.
- **Active selection** — at most one persona is active per install. Its uuid id is the top-level `ActivePersona` key, on the disk envelope and on the `/api/config` wire alike. `null` / absent / empty string means "no persona". There are no per-project or per-session override files.
- **Injection** — the active persona's `prompt` is appended to the LAST system block carrying `cache_control` (falling back to the last string text block). This keeps the persona *inside* the cached prefix, so it consumes no extra cache breakpoint and stays byte-stable across requests (preserving Anthropic's prompt cache). String and undefined `system` values are concatenated; multi-block array systems are mutated in place.
- **Surface restriction** — persona injection runs on **`/v1/messages` only**, and only on routed traffic: a passthrough surface, or a token pinned to the `passthrough` profile, skips the tier map and the persona with it. The OpenAI-compat and Gemini surfaces reject an enriched `system` field outright (Codex answers `Unsupported parameter: system`), so the enrichment is skipped there rather than breaking the request. Every routed request on `/v1/messages` inherits the active persona, whichever route served it — including one the map had no route for, which goes out on the caller's own model.
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

A subagent tag at the start of the second system block marks the request as subagent traffic:

```
<RIALTO-SUBAGENT-MODEL>subagent</RIALTO-SUBAGENT-MODEL>
Please help me analyze this code...
```

**It no longer selects anything.** The tier map has no subagent lane: a subagent's request is routed by the tier its own model name asks for, like any other. The tag is still read — only its presence; its contents are ignored — and recorded on the request log so Activity can tell subagent traffic apart. It is stripped before the request goes upstream on every surface, passthrough included, so the marker never reaches the vendor.

`<CCR-SUBAGENT-MODEL>` is the pre-rename spelling and is still recognised and stripped, because it lives in prompts people have already written. A tag whose body still names an old `provider,model` pair is harmless; the pair is simply not read.

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

**What applies on these surfaces.** Failover, account rotation, and the `provider,model` addressing always apply. Tier routing applies only once you switch the surface from `passthrough` to `routed` — and a model name that says no Claude family (`codex,gpt-5.5`, `gemini-2.5-pro`) asks for the `other` tier, so it is served by the profile's `other` routes, or passes through as sent when that group is empty. Persona injection does **not** apply — it is `/v1/messages` only (see Personas above).

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

Home directory, environment variables, database names, Docker image and thinking-signature prefixes all changed with the rename to Rialto, and the slot / rules / preset routing of earlier builds collapsed into chain and passthrough. The per-scenario chain has since been replaced by the tier map: on the first start of a build that has it, `db seed` (which the container entrypoint runs) converts each profile's `default` / `agent` chain into tier aliases and routes, once per profile. The other scenarios and the subagent lanes are not converted — nothing can reproduce them per tier — so re-add what you still want by hand. See [docs/guides/migration-v3.md](docs/guides/migration-v3.md) (Japanese).

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
| `bun run db:seed` | Idempotent seed — the `live` routing profile, with an empty tier map until you fill it in; also converts each profile's pre-tier-map chain into the tier map, once |
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
- [`docs/architecture/routing.md`](docs/architecture/routing.md) — the tier map: data model, gates, outcomes, the quota snapshot, model releases
- [`docs/architecture/pipeline-overview.md`](docs/architecture/pipeline-overview.md) — boot → request → upstream → response, end to end
- [`docs/architecture/request-flow.md`](docs/architecture/request-flow.md) — routing decisions and 429 rotation, in detail
- [`docs/architecture/testing-map.md`](docs/architecture/testing-map.md) — where the tests are and what they cover
- [`docs/guides/pwa.md`](docs/guides/pwa.md) — installed-app / PWA behaviour

## License

MIT — see `LICENSE`.
