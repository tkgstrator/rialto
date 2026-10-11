import { z } from 'zod'
import type { RequestSpec } from './types'

// These Anthropic-wire requests cover each transformer's richer round trips.
const ScenarioModelSchema = z.object({ provider: z.string().nonempty(), model: z.string().nonempty() })
type ScenarioModel = z.infer<typeof ScenarioModelSchema>

const TOOL_USE_TARGETS: ScenarioModel[] = [
  { provider: 'openai', model: 'gpt-4.1-mini' },
  { provider: 'google', model: 'gemini-2.5-flash' },
  { provider: 'claude-code', model: 'claude-haiku-4-5' },
  { provider: 'codex', model: 'gpt-5.5' }
]
const SYSTEM_TARGETS: ScenarioModel[] = [
  { provider: 'openai', model: 'gpt-4.1-mini' },
  { provider: 'google', model: 'gemini-2.5-flash' },
  { provider: 'claude-code', model: 'claude-haiku-4-5' }
]
const MULTI_TURN_TARGETS: ScenarioModel[] = [
  { provider: 'openai', model: 'gpt-4.1-mini' },
  { provider: 'google', model: 'gemini-2.5-flash' },
  { provider: 'claude-code', model: 'claude-haiku-4-5' }
]
const THINKING_TARGETS: ScenarioModel[] = [{ provider: 'claude-code', model: 'claude-opus-4-7' }]
const CACHE_TARGETS: ScenarioModel[] = [{ provider: 'claude-code', model: 'claude-haiku-4-5' }]
const REDACTED_THINKING_TARGETS: ScenarioModel[] = [{ provider: 'claude-code', model: 'claude-opus-4-7' }]

function toolUseBody({ provider, model }: ScenarioModel) {
  return {
    model: `${provider},${model}`,
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: 'What is the weather in Tokyo right now? You must call the get_weather tool — do not answer in text.'
      }
    ],
    tools: [
      {
        name: 'get_weather',
        description: 'Get the current weather for a city.',
        input_schema: {
          type: 'object',
          properties: {
            location: { type: 'string', description: 'City name, e.g. Tokyo' }
          },
          required: ['location']
        }
      }
    ],
    stream: true
  }
}

function systemBody({ provider, model }: ScenarioModel) {
  return {
    model: `${provider},${model}`,
    max_tokens: 50,
    system: 'You ONLY ever reply with the single word: pizza. No punctuation, no other text.',
    messages: [{ role: 'user', content: 'What is your favorite food?' }],
    stream: true
  }
}

function multiTurnBody({ provider, model }: ScenarioModel) {
  return {
    model: `${provider},${model}`,
    max_tokens: 50,
    messages: [
      { role: 'user', content: 'My favorite number is 17. Please remember it.' },
      { role: 'assistant', content: 'Got it — your favorite number is 17.' },
      { role: 'user', content: 'What is my favorite number? Reply with only the number.' }
    ],
    stream: true
  }
}

function thinkingBody({ provider, model }: ScenarioModel) {
  return {
    model: `${provider},${model}`,
    max_tokens: 2048,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    messages: [
      {
        role: 'user',
        content: 'What is 23 * 47? Think it through step by step, then give the final number only.'
      }
    ],
    stream: true
  }
}

// Long system text used in both cache-write and cache-read. Must be ≥1024 tokens
// so Anthropic actually creates a cache entry (the API silently ignores cache_control
// on prefixes shorter than the minimum). ~1200 tokens / ~4800 chars.
const LONG_CACHE_SYSTEM = `You are an expert software engineer specializing in TypeScript and distributed systems. You follow strict coding guidelines and best practices.

## Core Principles

### Code Quality
- Write clean, readable, maintainable code that future developers can easily understand.
- Prefer explicit over implicit — named constants beat magic numbers, descriptive variables beat single letters.
- Keep functions small and focused. A function should do exactly one thing and do it well.
- Avoid premature optimization. Write correct code first, then optimize only proven bottlenecks.
- Prefer composition over inheritance. Favor small composable units over deep class hierarchies.

### TypeScript Best Practices
- Enable strict mode in tsconfig.json and never suppress errors with @ts-ignore or as unknown.
- Use discriminated unions to model sum types. Never use boolean flags to track mutually exclusive states.
- Prefer readonly for data that should not change after construction.
- Use const assertions for literal types when the value is known at compile time.
- Avoid enums; prefer union types or const objects with as const.
- Never use any — use unknown and narrow explicitly. Every boundary between systems is unknown until proven otherwise.
- Utility types (Partial, Required, Pick, Omit, Record, ReturnType, Parameters) are your friends — learn them.
- Write type predicates and assertion functions to push type narrowing to the call site.

### Error Handling
- Never swallow errors silently. Log or rethrow, never just catch and ignore.
- Distinguish recoverable errors (wrong input, rate limits) from unrecoverable ones (OOM, filesystem corruption).
- Use custom error classes with typed payloads for errors that consumers must handle.
- Propagate context up the stack. A low-level "ENOENT" is useless; "failed to read config at ~/.config/app.json: ENOENT" is actionable.
- In async code, always handle promise rejection — unhandled rejections crash Node.js in production.

### Testing
- Write tests for observable behavior, not implementation details. Tests that break on refactors without functional changes are a liability.
- Unit tests cover pure functions and isolated modules. Integration tests cover module boundaries. E2E tests cover user workflows.
- Test the unhappy paths with the same rigor as the happy paths. The edge cases are where bugs live.
- Use table-driven tests (parameterized) for logic that varies by input. A loop over a cases array is cleaner than dozens of near-identical test bodies.
- Aim for tests that are deterministic and environment-independent. Avoid time-dependent assertions; mock the clock.

### API Design
- Follow REST semantics faithfully: GET is idempotent and cacheable, POST is not, PUT/PATCH/DELETE have specific contracts.
- Version your APIs from day one. Breaking changes in unversioned APIs cost you users.
- Return consistent error envelopes. Clients should not have to guess whether an error is in body.error, body.message, or body.errors[0].
- Paginate all list endpoints. Returning unbounded arrays is a DoS vector and a performance time bomb.
- Use ISO 8601 for all timestamps. Unix seconds and milliseconds in the same codebase is a bug waiting to happen.

### Database
- Never run unbounded queries. Always include LIMIT in user-facing queries.
- Use database transactions for operations that must be atomic. Partial writes are worse than no writes.
- Index columns that appear in WHERE, ORDER BY, and JOIN predicates. Unindexed full-table scans degrade as data grows.
- Avoid N+1 queries. Use JOIN or batch loading to fetch related records in one round trip.
- Write migrations as forward-only, idempotent scripts. Rollback migrations are rarely run and often broken; build forward instead.

### Security
- Never log secrets, API keys, or PII. Treat logs as potentially public.
- Validate and sanitize all user input at the system boundary. Never trust data from the network.
- Use parameterized queries. String interpolation in SQL is a SQL injection waiting to happen.
- Apply the principle of least privilege. Services should request only the permissions they need.
- Rotate secrets on a schedule and on suspected compromise. Hard-coded secrets are a security incident in waiting.

### Performance
- Measure before optimizing. Profile to find the actual bottleneck; do not guess.
- Prefer lazy evaluation for expensive operations. Compute only what is needed, when it is needed.
- Use connection pooling for database and HTTP clients. Opening a new connection per request is expensive.
- Cache at the appropriate layer: in-process for hot data, distributed cache for shared state, CDN for static assets.
- Compression reduces bandwidth cost. Enable gzip/brotli on HTTP responses for text payloads.

Reply to the user's question clearly and concisely, following these guidelines in all code you write.`

function cacheWriteBody({ provider, model }: ScenarioModel) {
  return {
    model: `${provider},${model}`,
    max_tokens: 64,
    system: [{ type: 'text', text: LONG_CACHE_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: "Reply with the word 'pong' only." }],
    stream: true
  }
}

function cacheReadBody({ provider, model }: ScenarioModel) {
  return {
    model: `${provider},${model}`,
    max_tokens: 64,
    system: [{ type: 'text', text: LONG_CACHE_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: "Reply with the word 'pong' only." },
      { role: 'assistant', content: 'pong' },
      { role: 'user', content: "Reply with the word 'pong' one more time." }
    ],
    stream: true
  }
}

function redactedThinkingBody({ provider, model }: ScenarioModel) {
  return {
    model: `${provider},${model}`,
    max_tokens: 2048,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    messages: [
      { role: 'user', content: 'What is 23 * 47? Think it through step by step.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: '',
            signature:
              'EqoBCkgIARAAGgpjbGF1ZGUtYWkqIGFudGhyb3BpYy1oYXNoZWQtY29udGVudC1zaWduYXR1cmUyIMO2rE9IHhcMzEzOGJmZjIxNjk0NzM0ZGZhZTgyMGM4'
          },
          { type: 'text', text: '23 × 47 = 1081' }
        ]
      },
      { role: 'user', content: 'What is 100 * 100? Reply with just the number.' }
    ],
    stream: true
  }
}

export function buildScenarioSpecs(messagesUrl: string): RequestSpec[] {
  const specs: RequestSpec[] = []
  for (const target of TOOL_USE_TARGETS) {
    specs.push({
      label: `${target.provider}/${target.model}: tool-use weather`,
      slug: `${target.provider}-${target.model}-tool-use`,
      method: 'POST',
      url: messagesUrl,
      body: toolUseBody(target)
    })
  }
  for (const target of SYSTEM_TARGETS) {
    specs.push({
      label: `${target.provider}/${target.model}: system prompt`,
      slug: `${target.provider}-${target.model}-system`,
      method: 'POST',
      url: messagesUrl,
      body: systemBody(target)
    })
  }
  for (const target of MULTI_TURN_TARGETS) {
    specs.push({
      label: `${target.provider}/${target.model}: multi-turn memory`,
      slug: `${target.provider}-${target.model}-multi-turn`,
      method: 'POST',
      url: messagesUrl,
      body: multiTurnBody(target)
    })
  }
  for (const target of THINKING_TARGETS) {
    specs.push({
      label: `${target.provider}/${target.model}: extended thinking`,
      slug: `${target.provider}-${target.model}-thinking`,
      method: 'POST',
      url: messagesUrl,
      body: thinkingBody(target)
    })
  }
  for (const target of CACHE_TARGETS) {
    specs.push({
      label: `${target.provider}/${target.model}: prompt cache write`,
      slug: `${target.provider}-${target.model}-cache-write`,
      method: 'POST',
      url: messagesUrl,
      body: cacheWriteBody(target)
    })
    specs.push({
      label: `${target.provider}/${target.model}: prompt cache read`,
      slug: `${target.provider}-${target.model}-cache-read`,
      method: 'POST',
      url: messagesUrl,
      body: cacheReadBody(target)
    })
  }
  for (const target of REDACTED_THINKING_TARGETS) {
    specs.push({
      label: `${target.provider}/${target.model}: redacted thinking multi-turn`,
      slug: `${target.provider}-${target.model}-redacted-thinking`,
      method: 'POST',
      url: messagesUrl,
      body: redactedThinkingBody(target)
    })
  }

  return specs
}
