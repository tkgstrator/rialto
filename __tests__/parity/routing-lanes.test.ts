/**
 * Parity matrix — surface parity for the scenario **lanes**.
 *
 * `routing-mode.test.ts` asks whether each surface can be set to routed
 * or passthrough, and whether tokens are counted in the surface's own
 * vocabulary. This asks the next question, which is master-plan §Phase 2's
 * completion condition itself: **once routed, does the surface actually
 * reach a lane other than default?**
 *
 * It did not. The mode became a per-surface setting, but the classifier
 * read **Anthropic's vocabulary directly** — `body.thinking`,
 * `body.output_config.effort`, `tools[].type` — so the other three fell
 * to `default` forever even when routed. The settings screen was not
 * lying; there was simply no road to the lane behind it.
 *
 * Each surface's request is written **in the spelling that surface's
 * clients actually send**. Normalisation is the job of
 * `scenario-router/surface-signals.ts`, and a test that pre-converts to
 * the Anthropic shape verifies nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import pino from 'pino'
import { ConfigStore } from '../../src/llms/registry/config'
import { TokenizerRegistry } from '../../src/llms/registry/tokenizer'
import { routeScenario } from '../../src/llms/scenario-router'
import type { RouterRequest } from '../../src/llms/scenario-router/types'
import { __setSurfacesForTests } from '../../src/services/inbound-surface-service'
import { __setPreferencesForTests } from '../../src/services/router-preference-service'
import { profileWith } from '../llms/chain-fixture'

const log = pino({ level: 'silent' })

const PROVIDERS = [
  {
    name: 'anthropic',
    auth_mode: 'api_key' as const,
    api_key: 'sk-x',
    api_base_url: 'https://api.anthropic.com/v1/messages',
    models: ['claude-sonnet-5', 'claude-opus-4-7', 'claude-haiku-4-5']
  }
]

// Every lane gets a distinct target so a mis-classification shows up as
// the wrong model rather than as a passing test.
const CHAIN = profileWith({
  'default.agent': ['anthropic,claude-sonnet-5'],
  'think.agent': ['anthropic,claude-opus-4-7'],
  'webSearch.agent': ['anthropic,claude-haiku-4-5'],
  'longContext.agent': ['anthropic,claude-opus-4-7']
})

async function run(path: string, body: Record<string, unknown>): Promise<RouterRequest> {
  const config = new ConfigStore({ Providers: PROVIDERS, providers: PROVIDERS })
  const tokenizers = new TokenizerRegistry(log)
  await tokenizers.initialize()
  const req: RouterRequest = {
    body: { model: 'caller,own-model', ...body } as RouterRequest['body'],
    log,
    inboundPath: path
  }
  await routeScenario(req, { config, tokenizers })
  return req
}

const PATHS = {
  'anthropic-messages': '/v1/messages',
  'openai-chat': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
  'gemini-generate': '/v1beta/models/gemini-3-pro:generateContent'
} as const

beforeEach(() => {
  __setSurfacesForTests({
    'anthropic-messages': 'routed',
    'openai-chat': 'routed',
    'openai-responses': 'routed',
    'gemini-generate': 'routed'
  })
  __setPreferencesForTests({ live: CHAIN })
})

afterEach(() => {
  __setSurfacesForTests({})
  __setPreferencesForTests(null)
})

describe('the think lane is reachable from all four surfaces', () => {
  // The same intent — asking for extended thinking — in each surface's
  // own spelling.
  const THINKING: Record<keyof typeof PATHS, Record<string, unknown>> = {
    'anthropic-messages': { thinking: { type: 'enabled', budget_tokens: 4096 } },
    'openai-chat': { reasoning_effort: 'high' },
    'openai-responses': { reasoning: { effort: 'high' } },
    'gemini-generate': { generationConfig: { thinkingConfig: { thinkingLevel: 'high' } } }
  }

  for (const [id, path] of Object.entries(PATHS)) {
    test(`${id}`, async () => {
      const req = await run(path, THINKING[id as keyof typeof PATHS])
      expect(req.scenarioType).toBe('think')
      expect(req.body.model).toBe('anthropic,claude-opus-4-7')
    })
  }
})

describe('the webSearch lane is reachable from all four surfaces', () => {
  // Every vendor spells its web-search tool differently. These use the
  // real spellings to confirm the decision is made on meaning rather
  // than on a glob.
  const WEB_SEARCH: Record<keyof typeof PATHS, Record<string, unknown>> = {
    'anthropic-messages': { tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
    'openai-chat': { tools: [{ type: 'web_search_preview' }] },
    'openai-responses': { tools: [{ type: 'web_search_preview' }] },
    'gemini-generate': { tools: [{ googleSearch: {} }] }
  }

  for (const [id, path] of Object.entries(PATHS)) {
    test(`${id}`, async () => {
      const req = await run(path, WEB_SEARCH[id as keyof typeof PATHS])
      expect(req.scenarioType).toBe('webSearch')
      expect(req.body.model).toBe('anthropic,claude-haiku-4-5')
    })
  }
})

describe('with no signal, all four fall to default', () => {
  // The other direction: this stops the two suites above from passing
  // because everything classifies as think.
  const PLAIN: Record<keyof typeof PATHS, Record<string, unknown>> = {
    'anthropic-messages': { messages: [{ role: 'user', content: 'hi' }] },
    'openai-chat': { messages: [{ role: 'user', content: 'hi' }] },
    'openai-responses': { input: 'hi' },
    'gemini-generate': { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }
  }

  for (const [id, path] of Object.entries(PATHS)) {
    test(`${id}`, async () => {
      const req = await run(path, PLAIN[id as keyof typeof PATHS])
      expect(req.scenarioType).toBe('default')
      expect(req.body.model).toBe('anthropic,claude-sonnet-5')
    })
  }
})

describe('webSearch wins over think, in the same order on every surface', () => {
  // The classifier's branch order is shared by all four. Raising both
  // signals at once confirms the order has not forked per surface.
  const BOTH: Record<keyof typeof PATHS, Record<string, unknown>> = {
    'anthropic-messages': {
      thinking: { type: 'enabled', budget_tokens: 4096 },
      tools: [{ type: 'web_search_20250305', name: 'web_search' }]
    },
    'openai-chat': { reasoning_effort: 'high', tools: [{ type: 'web_search_preview' }] },
    'openai-responses': { reasoning: { effort: 'high' }, tools: [{ type: 'web_search_preview' }] },
    'gemini-generate': {
      generationConfig: { thinkingConfig: { thinkingLevel: 'high' } },
      tools: [{ googleSearch: {} }]
    }
  }

  for (const [id, path] of Object.entries(PATHS)) {
    test(`${id}`, async () => {
      const req = await run(path, BOTH[id as keyof typeof PATHS])
      expect(req.scenarioType).toBe('webSearch')
    })
  }
})
