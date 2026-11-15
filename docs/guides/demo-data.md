# Demo data

`bun run db:seed:demo` fills a development install with enough data that
every screen renders something real: providers and models, subscription
quota, access tokens, and a month of traffic behind Activity and Overview.

It is **not** part of the container start-up, which only runs `prisma migrate deploy` and
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
deletes exactly those and nothing else, matched on the id prefix.
(`--clean` also still removes `RoutingWeightChange` rows an older
seed wrote; the scheduler writes none any more, and neither does the seed.)

**Yours — written only while still unset, and never taken back:** an
account's quota row is a singleton per key and cannot carry a marker. The
seed fills it in only when it is still empty, so running it against a
configured install adds traffic without re-pointing anything. The run's
summary says which ones it skipped.

The same rule decides where the targets come from: it uses the enabled
models already in the database, and only registers the bundled vendor
catalog when nothing at all is usable — a fresh install, before any vendor
is connected. It never invents a parallel set of fake vendors beside your
real ones.

## What the data looks like

Every request is recorded the way the gateway sends it: the model the
client named, as `passthrough` in `RequestLog.scenario` (the column outlived
the retired scenario routing and always reads `passthrough` now). About 15 %
of requests carry the subagent flag. Subscription traffic carries a
`subAccountId`, one account per provider for the whole session, the way the
account picker sticks a session to the account it first chose.

Sessions are weighted toward the present (roughly a quarter of them inside
the last day) because Activity opens on a 6-hour window and Overview on
24 — a uniform spread over 30 days would show an empty screen on first
load. Nothing is dated in the future.

The mix is deliberate rather than uniform: all four inbound surfaces, a
share of subagent-tagged requests, a
few 429 / 500 / 400 responses so the error-rate and failover views have
something to show, one account near its 5-hour ceiling carrying a recent
rate limit, some archived sessions, traffic from one since-revoked access token, and chat
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
| `scripts/seed-demo/targets.ts` | Resolving usable (provider, model) pairs |
| `scripts/seed-demo/accounts.ts` | Subscription accounts, quota, usage history |
| `scripts/seed-demo/tokens.ts` | Access tokens |
| `scripts/seed-demo/traffic.ts` | Sessions, messages, request logs (subagent flag, account, surface, token) |
| `scripts/seed-demo/conversations.ts` | The curated chat content |
| `scripts/seed-demo/random.ts` | The seeded PRNG |
