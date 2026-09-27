# Claude Code model discovery

The Providers Refresh action reads the published Claude Code model catalog at
`https://downloads.claude.ai/model-catalog/v1/catalog.json`. It selects the `cc`
model-selector configuration and models offered on `first_party`. This list is
**global**, not scoped to a connected Pro/Max account. It supplies candidates for
the Claude Code provider, not evidence that an account can call each model.

`/api/catalog/refresh` updates an in-process candidate list for the Add Provider
view. `/api/refresh-models` reads the same source for configured providers and
inserts newly discovered rows. The Anthropic pricing scrape reads the [official model-pricing table](https://platform.claude.com/docs/en/about-claude/pricing)
and joins its display names to model IDs; it supplies input, output and cache-read
API reference prices for matching IDs, but is not the authority for which
subscription models exist. The table also publishes 5m/1h cache-write rates;
Rialto's model price columns store only the base and cache-read rates (cache
writes are calculated separately from base input). These API prices do not
mean a subscription account is billed per token.
If discovery fails or its schema changes, existing models are retained and the
bundled subscription preset remains available; the refresh reports the failure.
The list is not fetched while serving an inference request.

Newly discovered models are **off** unless they are already in the preset's
curated default-enabled set. Neither Refresh nor a provider reconnect changes
existing model switches or tier aliases. To route to a new Opus release, enable
it (or select it as the Opus alias, which enables it) on the provider page and
save. The runtime provider and model switches remain the dispatch gates.

The Code catalog's advertised context window is not used as a subscription
entitlement check. The model row may receive a context value from Anthropic's
pricing/Models API; that published API limit does not establish what a specific
subscription account can use. The Code catalog is a versioned implementation
detail; its data is validated before use, and no OAuth credential is sent to it.
