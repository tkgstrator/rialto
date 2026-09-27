/**
 * The inbound-surface registry.
 *
 * The registry exists so that a surface's answers cannot disagree with
 * each other, and so a fifth surface is one descriptor rather than four
 * edits. These tests pin both halves of that: what each descriptor
 * answers, and that the derived lists (mount prefixes, auth conventions)
 * really are derived rather than a second copy.
 *
 * The `aggregateSse` case is the important regression: the aggregator
 * used to be chosen by transformer name in `route.ts`, and moving it
 * onto the descriptor is only safe because the two agree for every
 * surface. That agreement is asserted here against the real transformer
 * instances rather than assumed.
 */

import { describe, expect, test } from 'bun:test'
import {
  CATALOG_PATHS,
  catalogPathFor,
  INBOUND_MOUNT_PREFIXES,
  INBOUND_SURFACES,
  inboundTypeForPath,
  surfaceById,
  surfaceForPath
} from '../../src/llms/inbound/surfaces'
import { AnthropicTransformer, ClaudeCodeOauthTransformer } from '../../src/llms/transformers/anthropic'
import { GeminiTransformer } from '../../src/llms/transformers/gemini'
import {
  CodexOauthTransformer,
  OpenAIResponsesTransformer,
  OpenAITransformer
} from '../../src/llms/transformers/openai'
import {
  aggregateAnthropicSseToJson,
  aggregateGeminiSseToJson,
  aggregateOpenAiChatSseToJson,
  aggregateOpenAiResponsesSseToJson
} from '../../src/llms/utils/sse-aggregate'

describe('surfaceForPath', () => {
  test('the three /v1 surfaces match exactly', () => {
    expect(surfaceForPath('/v1/messages')?.id).toBe('anthropic-messages')
    expect(surfaceForPath('/v1/chat/completions')?.id).toBe('openai-chat')
    expect(surfaceForPath('/v1/responses')?.id).toBe('openai-responses')
  })

  test('gemini matches by prefix, because the model lives in the path', () => {
    expect(surfaceForPath('/v1beta/models/gemini-3-pro:generateContent')?.id).toBe('gemini-generate')
    expect(surfaceForPath('/v1beta/models/gemini-3-pro:streamGenerateContent')?.id).toBe('gemini-generate')
  })

  test('a catalog read is not a surface', () => {
    // /v1/models answers to an OpenAI SDK but nothing about it can be
    // routed, so bucketing it as a surface would put untracked rows on
    // the Overview breakdown.
    expect(surfaceForPath('/v1/models')).toBeUndefined()
    expect(catalogPathFor('/v1/models')?.errorShape).toBe('openai')
  })

  test('unknown and empty paths resolve to nothing', () => {
    expect(surfaceForPath('/v1/embeddings')).toBeUndefined()
    expect(surfaceForPath('/v1beta/tunedModels/x')).toBeUndefined()
    expect(surfaceForPath('')).toBeUndefined()
    expect(surfaceForPath(undefined)).toBeUndefined()
  })
})

describe('inboundTypeForPath', () => {
  test('reports the surface wire format, gemini included', () => {
    expect(inboundTypeForPath('/v1/messages')).toBe('anthropic')
    expect(inboundTypeForPath('/v1/chat/completions')).toBe('openai')
    expect(inboundTypeForPath('/v1/responses')).toBe('openai')
    expect(inboundTypeForPath('/v1beta/models/gemini-3-pro:generateContent')).toBe('gemini')
  })

  test('a non-surface path stays untyped rather than being bucketed', () => {
    expect(inboundTypeForPath('/v1/models')).toBeUndefined()
  })
})

describe('extractModel / extractStream', () => {
  const gemini = surfaceById('gemini-generate')!

  test('the model is the path segment before the action', () => {
    expect(gemini.extractModel?.('/v1beta/models/gemini-3-pro:generateContent')).toBe('gemini-3-pro')
  })

  test('a provider-qualified model survives, because the split is on the LAST colon', () => {
    // "provider,model" is how Rialto names a target, and a caller may
    // hand one straight to the gemini surface.
    expect(gemini.extractModel?.('/v1beta/models/google,gemini-3-pro:streamGenerateContent')).toBe(
      'google,gemini-3-pro'
    )
  })

  test('a path with no action yields no model rather than a truncated one', () => {
    expect(gemini.extractModel?.('/v1beta/models/gemini-3-pro')).toBeUndefined()
    expect(gemini.extractModel?.('/v1beta/models/:generateContent')).toBeUndefined()
  })

  test('only :streamGenerateContent is a stream', () => {
    expect(gemini.extractStream?.('/v1beta/models/m:streamGenerateContent')).toBe(true)
    expect(gemini.extractStream?.('/v1beta/models/m:generateContent')).toBe(false)
    expect(gemini.extractStream?.('/v1beta/models/m:countTokens')).toBe(false)
  })

  test('the body-carrying surfaces declare neither, so the route folds nothing in', () => {
    for (const id of ['anthropic-messages', 'openai-chat', 'openai-responses'] as const) {
      expect(surfaceById(id)?.extractModel).toBeUndefined()
      expect(surfaceById(id)?.extractStream).toBeUndefined()
    }
  })
})

describe('aggregateSse', () => {
  // The pre-registry dispatch, reproduced verbatim from route.ts.
  const byTransformerName = (name: string): unknown => {
    if (name === 'openai') return aggregateOpenAiChatSseToJson
    if (name === 'openai-responses') return aggregateOpenAiResponsesSseToJson
    return aggregateAnthropicSseToJson
  }

  test('every descriptor picks what the transformer-name dispatch picked', () => {
    // A transformer is only reachable from a surface through the
    // endpoint it registered, so this is the full set of (surface,
    // transformer) pairs the old code could ever see. Gemini is absent
    // from it because its surface was never mounted — that one is new,
    // not a change.
    const reachable: Array<{ endpoint: string; name: string }> = [
      new AnthropicTransformer(),
      new ClaudeCodeOauthTransformer(),
      new OpenAITransformer(),
      new OpenAIResponsesTransformer(),
      new CodexOauthTransformer(),
      new GeminiTransformer()
    ]
      .filter((t) => t.endPoint !== undefined)
      .map((t) => ({ endpoint: t.endPoint!, name: t.name }))

    for (const { endpoint, name } of reachable) {
      const surface = INBOUND_SURFACES.find((s) => s.endpoint === endpoint)
      expect(surface).toBeDefined()
      if (surface?.id === 'gemini-generate') continue
      expect(surface?.aggregateSse).toBe(byTransformerName(name) as typeof surface.aggregateSse)
    }
  })

  test('gemini folds into the Gemini envelope', () => {
    expect(surfaceById('gemini-generate')?.aggregateSse).toBe(aggregateGeminiSseToJson)
  })
})

describe('derived mount lists', () => {
  test('the prefixes cover every surface and catalog path', () => {
    const covered = (path: string): boolean =>
      INBOUND_MOUNT_PREFIXES.some((prefix) => path.startsWith(prefix.slice(0, -1)))
    for (const surface of INBOUND_SURFACES) expect(covered(surface.path)).toBe(true)
    for (const catalog of CATALOG_PATHS) expect(covered(catalog.path)).toBe(true)
  })

  test('one prefix per distinct root, not one per path', () => {
    expect([...INBOUND_MOUNT_PREFIXES].sort()).toEqual(['/v1/*', '/v1beta/*'])
  })
})

describe('descriptor completeness', () => {
  test('every surface answers all four questions that used to be scattered', () => {
    for (const surface of INBOUND_SURFACES) {
      expect(typeof surface.errorShape).toBe('string')
      expect(typeof surface.auth).toBe('string')
      expect(typeof surface.inboundType).toBe('string')
      expect(typeof surface.aggregateSse).toBe(surface.operation === 'completion' ? 'function' : 'undefined')
    }
  })

  test('ids are unique and resolvable', () => {
    const ids = INBOUND_SURFACES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(surfaceById(id)?.id).toBe(id)
  })
})
