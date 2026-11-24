# Bare model names and provider priority

Clients name a model by its native name, for example `gpt-5.6-sol`. `GET /v1/models` publishes one `id` per callable bare name; Codex MCP `status` does the same. Rialto keeps `provider,model` internally for routing, authorization, accounting and failover, and removes the provider prefix before sending the upstream request. Older clients may still send a qualified pair, but new clients do not need to know the provider.

When multiple enabled providers offer the same model, go to **Providers → Priorities** and choose a primary provider. The remaining providers are the fallback order and can be moved up or down. Without an explicit priority, the ambiguous model is omitted from the public catalog and a bare request is refused rather than sending it to an arbitrary account. A token plan restricts the eligible providers before a priority is applied.

The admin API is `GET /api/models/provider-priorities` and `PUT /api/models/provider-priorities` with `{ "model": "gpt-5.6-sol", "providers": ["codex", "openai"] }`. An empty providers array clears the preference. Only providers that have that model can be saved. Deleting a model removes its preference row. The UI and API use the same global order across completion and image entry points; Codex MCP considers only Codex subscription providers.

A client that names `provider,model` goes to exactly that provider; the preference only orders the providers behind a bare name. A preference does not override a surface's denied targets or an access token's plan. Rialto does not claim that shortening catalog IDs alone fixes Codex Desktop's reported editing-tool behavior; test a new Desktop thread with the native ID after deployment.

## Per token: subscription or API key

The priority above is global. An access token can override which billing method serves it under **Provider** on the token's page: follow the system priority, use only a subscription or only an API key, or prefer one of them. A preferred method is tried first, and the priority still orders the providers within each method; a 429 or 503 then moves on to the other method. **Only** never does, so choose it when the other method must not be used.

**Override** sets the same choice for single models, so one token can prefer the API key for `claude-opus-5-5` while everything else stays on the subscription. A rule names the bare model, so it covers every subscription and API-key provider serving it. Only a model that both a subscription and an API key serve can be added; a rule that insists on a method nothing serves for this token refuses that model, and the page says so. A model without a rule follows the token-wide setting. Rules belong to the token: a folder's defaults do not carry them, and moving a token between folders leaves them alone.
