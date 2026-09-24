# Demo data

`bun run db:seed:demo` fills a development install with enough data that
all six screens render something real: providers and models, tier
aliases and tier maps, subscription quota, access tokens, and a month of
traffic behind Activity and Overview.

It is **not** wired into `prisma db seed` — that runs in production, and
must stay side-effect free. This one is always explicit.

```bash
bun run db:seed:demo                        # seed (replaces the previous demo rows)
bun run db:seed:demo -- --clean             # remove the demo rows and stop
bun run db:seed:demo -- --days=7 --sessions=25
bun run db:seed:demo -- --seed=42           # different data, still reproducible
```

## What it will and will not touch

The seed runs against working installs, so it draws a hard line between
rows it owns and configuration you own.

**Demo-owned — replaced on every run, removed by `--clean`:** every row
written into a table that also holds real data carries an explicit
`demo-` id — sessions, messages, request logs, access tokens, generated
usage samples, and any subscription account it had to invent. `--clean`
deletes exactly those and nothing else, matched on the id prefix. The one
exception is the `cost-first` profile, which is matched on its key instead:
the key is reserved for the seed, and the profile's tier routes cascade
with it. (`--clean` also still removes `RoutingWeightChange` rows an older
seed wrote; the scheduler writes none any more, and neither does the seed.)

**Yours — written only while still unset, and never taken back:** some
configuration is a singleton per key and cannot carry a marker — a
provider's tier alias, the `live` tier map, a surface's routing mode, an
account's quota row. The seed fills each of those in only when it is still
empty — an alias only for a `(provider, tier)` that has none, the `live`
map only while it has no routes at all, a surface only while it still
carries the seeded passthrough default — so running it against a
configured install adds traffic without re-pointing anything. The run's
summary says which ones it skipped.

The same rule decides where the routing targets come from: it uses the
enabled models already in the database, and only registers the bundled
vendor catalog when nothing at all is routable — a fresh install, before
any vendor is connected. It never invents a parallel set of fake vendors
beside your real ones.

## The tier maps it writes

Aliases come from those targets. A model whose name says its tier
(`claude-sonnet-5`) is aliased as that tier. A provider whose model names
say no Claude family gets stand-ins picked by name — `astra` as fable,
`-sol` as opus, `terra` / `flash` as sonnet, `luna` / `flash-lite` as
haiku — taking the last match in name order, which for names like
`claude-opus-4-7` / `claude-opus-5` is the newer generation. The stand-ins
are demo choices written against the bundled catalog, not a rule the
router knows: on a real install an operator picks them on each provider's
page. An alias the install already has always wins over the plan, and the
maps below are built from what is actually stored.

| Profile | When written | Routes per tier | Constraints |
|---|---|---|---|
| `live` | only while it has no routes | up to three providers, subscriptions first | the defaults (`429`, quota skip 100 %, error-rate skip 0.5, 5 samples) |
| `cost-first` | every run | up to three providers, cheapest alias first — unpriced (subscription) models last, because "no price" is not "cheapest" | quota skip 90 %, exhausted → passthrough, so the constraints block has non-defaults to show |

In both, `haiku` also carries the first `sonnet` route, switched off, so
the Routing screen shows a route standing in for another tier and the
per-route toggle in its off state. `other` goes to the first sonnet route
on a provider that is not a subscription — the one a `gpt-*` or `gemini-*`
caller can plausibly be served by — or to the first sonnet route when every
one is a subscription.

Surfaces follow suit: `/v1/messages` routes through `live`,
`/v1/chat/completions` through `cost-first` (a per-surface profile
override), and the Responses and Gemini surfaces stay in passthrough, so
both modes are on screen at once.

## What the data looks like

Traffic is generated against the same tier maps the seed wrote, so
Activity and Routing tell the same story. Each request's tier is read off
the model name its client asked for, as the router does; a tier with
routes is served by its first route most of the time and by a later one
otherwise, and a tier with none — or any request on a passthrough
surface — is recorded as `passthrough` on the model it named. The route
lands in `RequestLog.scenario` (the column kept its old name), and
subscription traffic carries a `subAccountId`, one account per provider
for the whole session, the way the account picker sticks a session to the
account it first chose.

Sessions are weighted toward the present (roughly a quarter of them inside
the last day) because Activity opens on a 6-hour window and Overview on
24 — a uniform spread over 30 days would show an empty screen on first
load. Nothing is dated in the future.

The mix is deliberate rather than uniform: all four inbound surfaces,
routed tiers next to passthrough, a share of subagent-tagged requests, a
few 429 / 500 / 400 responses so the error-rate and failover views have
something to show, one account near its 5-hour ceiling carrying a recent
rate limit, some archived sessions, one revoked access token, and chat
content on the newest handful of sessions only — which is what an install
that turned `CAPTURE_MESSAGES` on partway through actually looks like.

Numbers come from a seeded PRNG, so two runs produce the same rows and a
screenshot or mock diff stays comparable across them.

The demo access tokens are display-only. Each row's plaintext is
generated, hashed and discarded inside the seed, so the Access screen has
a populated list and no working credential for the install exists
anywhere.

## Layout

| Path | Contents |
|---|---|
| `scripts/seed-demo-data.ts` | Entry point: flags, run order, summary |
| `scripts/seed-demo/demo-rows.ts` | The `demo-` id convention and `--clean` |
| `scripts/seed-demo/targets.ts` | Resolving routable (provider, model) pairs |
| `scripts/seed-demo/routing.ts` | Tier aliases, the `live` and `cost-first` tier maps, surface modes |
| `scripts/seed-demo/accounts.ts` | Subscription accounts, quota, usage history |
| `scripts/seed-demo/tokens.ts` | Access tokens |
| `scripts/seed-demo/traffic.ts` | Sessions, messages, request logs (route, account, surface, token) |
| `scripts/seed-demo/conversations.ts` | The curated chat content |
| `scripts/seed-demo/random.ts` | The seeded PRNG |
