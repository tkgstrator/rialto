/**
 * The pure rules of the Custom provider.
 *
 * The Connect form previews these live and the route stores the same
 * strings, so what is pinned here is that both sides read one answer: which
 * names are free, which endpoint a typed Base URL turns into, and where the
 * model list is looked for.
 */
import { describe, expect, test } from 'bun:test'
import {
  CUSTOM_API_STYLES,
  CUSTOM_NAME_MAX_LENGTH,
  customEndpointUrl,
  customModelsUrls,
  customNameProblem,
  isBuiltInVendorName,
  isCustomApiStyle,
  isCustomProvider,
  parseCustomBaseUrl
} from '../../src/shared/custom-provider'
import { SUBSCRIPTION_PRESETS, VENDOR_DEFAULTS } from '../../src/shared/data'

describe('wire formats', () => {
  test('exactly the three a typed Base URL can describe, and never gemini', () => {
    expect([...CUSTOM_API_STYLES]).toEqual(['anthropic', 'openai_chat', 'openai_responses'])
    expect(isCustomApiStyle('gemini')).toBe(false)
  })

  test('isCustomApiStyle accepts each of the three and nothing else', () => {
    for (const style of CUSTOM_API_STYLES) expect(isCustomApiStyle(style)).toBe(true)
    expect(isCustomApiStyle('openai')).toBe(false)
    expect(isCustomApiStyle('')).toBe(false)
    expect(isCustomApiStyle(undefined)).toBe(false)
  })
})

describe('customNameProblem', () => {
  test('a plain slug is free', () => {
    expect(customNameProblem('my-gateway')).toBeNull()
    expect(customNameProblem('lm-studio')).toBeNull()
    expect(customNameProblem('vllm.local_2')).toBeNull()
    expect(customNameProblem('a')).toBeNull()
  })

  test('surrounding whitespace is ignored, as the route trims before storing', () => {
    expect(customNameProblem('  my-gateway  ')).toBeNull()
  })

  test('empty and blank are "empty", which the form treats as unfinished rather than wrong', () => {
    expect(customNameProblem('')).toBe('empty')
    expect(customNameProblem('   ')).toBe('empty')
  })

  test('the length limit is inclusive', () => {
    expect(customNameProblem('a'.repeat(CUSTOM_NAME_MAX_LENGTH))).toBeNull()
    expect(customNameProblem('a'.repeat(CUSTOM_NAME_MAX_LENGTH + 1))).toBe('too_long')
  })

  test.each([
    ['a space', 'my gateway'],
    ['a slash', 'my/gateway'],
    ['a comma, which would split the provider,model id', 'my,gateway'],
    ['a leading dash', '-gateway'],
    ['a trailing dot', 'gateway.'],
    ['a non-ASCII letter', 'gatewäy']
  ])('%s is a charset problem', (_label, name) => {
    expect(customNameProblem(name)).toBe('charset')
  })

  test('every api_key vendor in the catalog is reserved', () => {
    for (const vendor of Object.keys(VENDOR_DEFAULTS)) {
      expect(customNameProblem(vendor)).toBe('reserved')
    }
  })

  test('every subscription preset is reserved', () => {
    for (const preset of SUBSCRIPTION_PRESETS) expect(customNameProblem(preset.id)).toBe('reserved')
  })

  test('a name that apiStyleForVendor would read as claude-code is reserved by prefix', () => {
    expect(customNameProblem('claude-code-proxy')).toBe('reserved')
  })

  test('the rail card id and the SPA route segments are reserved', () => {
    for (const word of ['custom', 'gemini-cli', 'connect', 'models', 'test']) {
      expect(customNameProblem(word)).toBe('reserved')
    }
  })

  test('capitals are allowed and kept as typed', () => {
    expect(customNameProblem('MyGateway')).toBeNull()
  })

  test('a built-in or reserved name in capitals is still reserved', () => {
    expect(customNameProblem('OpenAI')).toBe('reserved')
    expect(customNameProblem('Claude-Code-Proxy')).toBe('reserved')
    expect(customNameProblem('Models')).toBe('reserved')
  })
})

describe('isCustomProvider', () => {
  test('an api_key provider under an unknown name is custom', () => {
    expect(isCustomProvider('my-gateway', 'api_key')).toBe(true)
  })

  test('catalog vendors are not custom', () => {
    for (const vendor of Object.keys(VENDOR_DEFAULTS)) expect(isCustomProvider(vendor, 'api_key')).toBe(false)
  })

  test('subscription providers are never custom, whatever their name', () => {
    expect(isCustomProvider('claude-code', 'subscription')).toBe(false)
    expect(isCustomProvider('some-proxy', 'subscription')).toBe(false)
  })

  test('isBuiltInVendorName does not treat Object.prototype keys as vendors', () => {
    expect(isBuiltInVendorName('toString')).toBe(false)
    expect(isBuiltInVendorName('constructor')).toBe(false)
  })
})

describe('parseCustomBaseUrl', () => {
  test('a bare origin has an empty head', () => {
    expect(parseCustomBaseUrl('http://localhost:1234')).toEqual({
      origin: 'http://localhost:1234',
      head: '',
      typedTail: false
    })
  })

  test('a trailing slash is dropped and the path kept', () => {
    expect(parseCustomBaseUrl('https://gw.example.com/openai/v1/')).toEqual({
      origin: 'https://gw.example.com',
      head: '/openai/v1',
      typedTail: false
    })
  })

  test('surrounding whitespace is trimmed', () => {
    expect(parseCustomBaseUrl('  http://localhost:11434  ')?.origin).toBe('http://localhost:11434')
  })

  test.each([
    ['/chat/completions', '/v1/chat/completions', '/v1'],
    ['/responses', '/v1/responses', '/v1'],
    ['/messages', '/v1/messages', '/v1']
  ])('a typed endpoint tail %s is recognised and split off', (_tail, path, head) => {
    expect(parseCustomBaseUrl(`http://host:1${path}`)).toEqual({ origin: 'http://host:1', head, typedTail: true })
  })

  test('private and loopback addresses are allowed: LM Studio and Ollama are the main use case', () => {
    expect(parseCustomBaseUrl('http://127.0.0.1:1234/v1')).not.toBeNull()
    expect(parseCustomBaseUrl('http://192.168.1.20:11434')).not.toBeNull()
    expect(parseCustomBaseUrl('http://[::1]:8080')).not.toBeNull()
  })

  test.each([
    ['empty', ''],
    ['blank', '   '],
    ['no scheme', 'localhost:1234'],
    ['not a URL', 'not a url'],
    ['ftp', 'ftp://example.com/v1'],
    ['file', 'file:///etc/passwd'],
    ['javascript', 'javascript:alert(1)'],
    ['a username', 'http://user@example.com'],
    ['a password', 'http://user:pw@example.com'],
    ['a query', 'https://example.com/v1?key=secret'],
    ['a fragment', 'https://example.com/v1#frag']
  ])('%s is refused', (_label, raw) => {
    expect(parseCustomBaseUrl(raw)).toBeNull()
  })
})

describe('customEndpointUrl', () => {
  test('a bare origin gets /v1 and the chat tail', () => {
    expect(customEndpointUrl('http://localhost:1234', 'openai_chat')).toBe('http://localhost:1234/v1/chat/completions')
  })

  test('a base that already ends in /v1 is not doubled', () => {
    expect(customEndpointUrl('http://localhost:1234/v1', 'openai_chat')).toBe(
      'http://localhost:1234/v1/chat/completions'
    )
    expect(customEndpointUrl('http://localhost:1234/v1/', 'openai_responses')).toBe(
      'http://localhost:1234/v1/responses'
    )
    expect(customEndpointUrl('http://localhost:1234/v1', 'anthropic')).toBe('http://localhost:1234/v1/messages')
  })

  test('the wire format picks the tail', () => {
    expect(customEndpointUrl('https://gw.example.com', 'openai_responses')).toBe('https://gw.example.com/v1/responses')
    expect(customEndpointUrl('https://gw.example.com', 'anthropic')).toBe('https://gw.example.com/v1/messages')
  })

  test('a gateway mounted under its own path keeps it for the OpenAI formats', () => {
    expect(customEndpointUrl('https://gw.example.com/openai', 'openai_chat')).toBe(
      'https://gw.example.com/openai/chat/completions'
    )
  })

  test('an anthropic path without /v1 gets one, because Messages lives under it', () => {
    expect(customEndpointUrl('https://gw.example.com/anthropic', 'anthropic')).toBe(
      'https://gw.example.com/anthropic/v1/messages'
    )
  })

  test('a typed endpoint is taken literally, not given /v1 again', () => {
    expect(customEndpointUrl('https://gw.example.com/chat/completions', 'openai_chat')).toBe(
      'https://gw.example.com/chat/completions'
    )
  })

  test('a typed tail is replaced by the chosen format, so switching the card retargets it', () => {
    expect(customEndpointUrl('https://gw.example.com/v1/chat/completions', 'openai_responses')).toBe(
      'https://gw.example.com/v1/responses'
    )
  })

  test('a Base URL the parser refuses has no endpoint', () => {
    expect(customEndpointUrl('localhost:1234', 'openai_chat')).toBeNull()
    expect(customEndpointUrl('http://u:p@host', 'openai_chat')).toBeNull()
  })
})

describe('customModelsUrls', () => {
  test('a bare origin is asked at /v1/models first', () => {
    expect(customModelsUrls('http://localhost:1234', 'openai_chat')).toEqual([
      'http://localhost:1234/v1/models',
      'http://localhost:1234/models'
    ])
  })

  test('a base ending in /v1 is asked at /v1/models without doubling, then at the origin', () => {
    expect(customModelsUrls('http://localhost:1234/v1', 'openai_chat')).toEqual([
      'http://localhost:1234/v1/models',
      'http://localhost:1234/models'
    ])
  })

  test('candidates are unique', () => {
    for (const raw of ['http://h:1', 'http://h:1/v1', 'http://h:1/v1/chat/completions', 'http://h:1/a/b']) {
      for (const style of CUSTOM_API_STYLES) {
        const urls = customModelsUrls(raw, style)
        expect(new Set(urls).size).toBe(urls.length)
      }
    }
  })

  test('a typed endpoint yields the list next to it', () => {
    expect(customModelsUrls('https://gw.example.com/v1/chat/completions', 'openai_chat')[0]).toBe(
      'https://gw.example.com/v1/models'
    )
  })

  test('a gateway path keeps its own prefix on the first candidate', () => {
    expect(customModelsUrls('https://gw.example.com/openai', 'openai_chat')[0]).toBe(
      'https://gw.example.com/openai/models'
    )
  })

  test('a Base URL the parser refuses has no candidates', () => {
    expect(customModelsUrls('nope', 'openai_chat')).toEqual([])
  })
})
