/**
 * Regression: bypass-mode header passthrough used to forward the
 * client's own `Authorization` (which for Rialto is the caller's Rialto
 * access token, not any upstream credential). buildRequestHeaders set
 * `Authorization: Bearer <provider.api_key>` first, then spread the
 * inbound header set on top — the lowercase `authorization` in the
 * spread overwrote the correct default, so OpenAI upstream received
 * the Rialto credential as its Bearer and 400'd with "Incorrect API key".
 *
 * The strip now also targets x-api-key (Anthropic idiom) for the
 * same reason. content-length + accept-encoding stripping (hop-by-hop
 * / decompression) stays.
 */

import { describe, expect, test } from 'bun:test'
import { processRequestTransformers } from '../../src/llms/pipeline/request-chain'
import type { ResolvedProvider } from '../../src/llms/registry/provider'
import type { Transformer } from '../../src/llms/transformers/base'
import type { TransformerContext, UnifiedChatRequest } from '../../src/schemas/domain'

// Bare-minimum transformer stub — bypass mode doesn't call any hooks
// other than auth() (which is invoked separately in provider-send).
class NoopTransformer {
  readonly name = 'noop'
  async transformRequestOut(request: unknown): Promise<UnifiedChatRequest> {
    return request as UnifiedChatRequest
  }
  async transformRequestIn(request: UnifiedChatRequest): Promise<UnifiedChatRequest> {
    return request
  }
  async transformResponseOut(response: Response): Promise<Response> {
    return response
  }
  async transformResponseIn(response: Response): Promise<Response> {
    return response
  }
  async auth(request: unknown): Promise<unknown> {
    return request
  }
}

function inputWithHeaders(headers: Record<string, string>): {
  body: unknown
  headers: Record<string, string>
  provider: ResolvedProvider
  transformer: Transformer
  context: TransformerContext
} {
  return {
    body: { model: 'x', messages: [] },
    headers,
    // biome-ignore plugin: ResolvedProvider is heavy — only .transformer is read in the bypass branch we're exercising, and the request-chain passes provider through without touching it.
    provider: {} as unknown as ResolvedProvider,
    // biome-ignore plugin: NoopTransformer covers the abstract surface Transformer requires. Full cast is safer than a partial stub.
    transformer: new NoopTransformer() as unknown as Transformer,
    context: {} as TransformerContext
  }
}

describe('processRequestTransformers — bypass mode header strip', () => {
  test('strips lowercase authorization so provider.api_key wins', async () => {
    const { config } = await processRequestTransformers(
      inputWithHeaders({
        authorization: 'Bearer rialto-caller-key',
        'content-type': 'application/json',
        'x-something': 'keep'
      }),
      true
    )
    expect(config.headers?.authorization).toBeUndefined()
    expect(config.headers?.['x-something']).toBe('keep')
    expect(config.headers?.['content-type']).toBe('application/json')
  })

  test('strips Authorization regardless of case', async () => {
    const { config } = await processRequestTransformers(
      inputWithHeaders({
        Authorization: 'Bearer rialto-caller-key',
        'X-Api-Key': 'rialto-caller-key'
      }),
      true
    )
    expect(config.headers?.Authorization).toBeUndefined()
    expect(config.headers?.['X-Api-Key']).toBeUndefined()
  })

  test('strips content-length and accept-encoding (hop-by-hop, preserved behaviour)', async () => {
    const { config } = await processRequestTransformers(
      inputWithHeaders({
        'content-length': '42',
        'accept-encoding': 'gzip, deflate',
        'content-type': 'application/json'
      }),
      true
    )
    expect(config.headers?.['content-length']).toBeUndefined()
    expect(config.headers?.['accept-encoding']).toBeUndefined()
    expect(config.headers?.['content-type']).toBe('application/json')
  })

  test('non-bypass mode still starts config with an empty header set (not touched by this fix)', async () => {
    const { config } = await processRequestTransformers(
      inputWithHeaders({ authorization: 'Bearer rialto-caller-key' }),
      false
    )
    // Non-bypass never copies inbound headers into config; the provider
    // Bearer stamped by buildRequestHeaders is the only Authorization
    // that reaches the upstream in that path.
    expect(config.headers).toBeUndefined()
  })

  // A remote Rialto fronted by Cloudflare receives cf-* / cdn-loop /
  // x-forwarded-* headers on every inbound request. Forwarding them to
  // api.openai.com (also Cloudflare-fronted) triggered CF's loop
  // detection → 403 HTML back to the client. The strip below is what
  // separates "model test passes but SDK 403s" from a working request.
  test('strips Cloudflare / proxy trail headers so a CF-fronted upstream does not reject as a loop', async () => {
    const { config } = await processRequestTransformers(
      inputWithHeaders({
        'cf-ray': '9abc1234-KIX',
        'cf-connecting-ip': '203.0.113.5',
        'cf-visitor': '{"scheme":"https"}',
        'cf-ipcountry': 'JP',
        'cdn-loop': 'cloudflare',
        'x-forwarded-for': '203.0.113.5',
        'x-forwarded-proto': 'https',
        'x-real-ip': '203.0.113.5',
        via: '1.1 example.net',
        forwarded: 'for=203.0.113.5;proto=https',
        'content-type': 'application/json'
      }),
      true
    )
    // Every proxy-trail header is gone.
    expect(config.headers?.['cf-ray']).toBeUndefined()
    expect(config.headers?.['cf-connecting-ip']).toBeUndefined()
    expect(config.headers?.['cf-visitor']).toBeUndefined()
    expect(config.headers?.['cf-ipcountry']).toBeUndefined()
    expect(config.headers?.['cdn-loop']).toBeUndefined()
    expect(config.headers?.['x-forwarded-for']).toBeUndefined()
    expect(config.headers?.['x-forwarded-proto']).toBeUndefined()
    expect(config.headers?.['x-real-ip']).toBeUndefined()
    expect(config.headers?.via).toBeUndefined()
    expect(config.headers?.forwarded).toBeUndefined()
    // Non-trail headers still pass through.
    expect(config.headers?.['content-type']).toBe('application/json')
  })

  test('strips inbound Host so undici cannot leak the Rialto domain into the upstream request', async () => {
    // api.openai.com routes by Host; a stale `Host: llm.tkgstrator.work`
    // spread onto the upstream call would earn a 403 by itself.
    const { config } = await processRequestTransformers(
      inputWithHeaders({ Host: 'llm.tkgstrator.work', 'content-type': 'application/json' }),
      true
    )
    expect(config.headers?.Host).toBeUndefined()
    expect(config.headers?.host).toBeUndefined()
  })

  test('strips any x-forwarded-* variant, not just the well-known ones', async () => {
    const { config } = await processRequestTransformers(
      inputWithHeaders({
        'x-forwarded-host': 'llm.tkgstrator.work',
        'x-forwarded-port': '443',
        'x-forwarded-server': 'edge-42',
        keep: 'me'
      }),
      true
    )
    expect(config.headers?.['x-forwarded-host']).toBeUndefined()
    expect(config.headers?.['x-forwarded-port']).toBeUndefined()
    expect(config.headers?.['x-forwarded-server']).toBeUndefined()
    expect(config.headers?.keep).toBe('me')
  })

  test('strips any cf-* variant (Cloudflare adds several beyond the common four)', async () => {
    const { config } = await processRequestTransformers(
      inputWithHeaders({
        'cf-request-id': 'r-1',
        'cf-worker': 'w-2',
        'cf-warp-tag-id': 't-3',
        keep: 'me'
      }),
      true
    )
    expect(config.headers?.['cf-request-id']).toBeUndefined()
    expect(config.headers?.['cf-worker']).toBeUndefined()
    expect(config.headers?.['cf-warp-tag-id']).toBeUndefined()
    expect(config.headers?.keep).toBe('me')
  })
})

describe('shouldStripInboundHeader', () => {
  test('exact matches are case-insensitive', async () => {
    const { shouldStripInboundHeader } = await import('../../src/llms/pipeline/request-chain')
    expect(shouldStripInboundHeader('Content-Length')).toBe(true)
    expect(shouldStripInboundHeader('CONTENT-LENGTH')).toBe(true)
    expect(shouldStripInboundHeader('content-length')).toBe(true)
  })

  test('prefixes catch every casing variant', async () => {
    const { shouldStripInboundHeader } = await import('../../src/llms/pipeline/request-chain')
    expect(shouldStripInboundHeader('Cf-Ray')).toBe(true)
    expect(shouldStripInboundHeader('CF-CONNECTING-IP')).toBe(true)
    expect(shouldStripInboundHeader('X-Forwarded-For')).toBe(true)
  })

  test('non-listed headers pass through', async () => {
    const { shouldStripInboundHeader } = await import('../../src/llms/pipeline/request-chain')
    expect(shouldStripInboundHeader('content-type')).toBe(false)
    expect(shouldStripInboundHeader('user-agent')).toBe(false)
    expect(shouldStripInboundHeader('anthropic-version')).toBe(false)
  })
})
