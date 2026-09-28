# Claude Code model discovery

The Providers Refresh action reads the published Claude Code model catalog at
`https://downloads.claude.ai/model-catalog/v1/catalog.json`. It selects the `cc`
model-selector configuration and models offered on `first_party`. This list is
**global**, not scoped to a connected Pro/Max account. It supplies candidates for
the Claude Code provider, not evidence that an account can call each model.

`/api/catalog/refresh` updates an in-process candidate list for the Add Provider
view, and the first `/api/catalog` read in a fresh process fetches it once when
it is still empty (a failure is not retried for five minutes), because no model
list ships with Rialto. `/api/refresh-models` reads the same source for
configured providers and inserts newly discovered rows. The Anthropic pricing scrape reads the [official model-pricing table](https://platform.claude.com/docs/en/about-claude/pricing)
and joins its display names to model IDs; it supplies input, output and cache-read
API reference prices for matching IDs, but is not the authority for which
subscription models exist. The table also publishes 5m/1h cache-write rates;
Rialto's model price columns store only the base and cache-read rates (cache
writes are calculated separately from base input). These API prices do not
mean a subscription account is billed per token.
If discovery fails or its schema changes, existing models are retained and the
refresh reports the failure; a provider added while the catalog was unreachable
gets its models on the next Refresh.
The list is not fetched while serving an inference request.

Newly discovered models are always **off** — on a new provider as on an existing
one — and neither Refresh nor a provider reconnect changes existing model
switches. A tier routes to the newest switched-on model its name says
([routing.md](./routing.md#tiers-and-model-releases)), so to route to a new Opus
release, switch it on on the provider page and save: the Opus tier moves to it.
The runtime provider and model switches remain the dispatch gates.

The Code catalog's advertised context window is not used as a subscription
entitlement check. The model row may receive a context value from Anthropic's
pricing/Models API; that published API limit does not establish what a specific
subscription account can use. The Code catalog is a versioned implementation
detail; its data is validated before use, and no OAuth credential is sent to it.
