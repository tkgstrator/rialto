import { afterEach, describe, expect, test } from 'bun:test'
import {
  imageModelSnapshot,
  parseImageModelPage,
  refreshImageModelDetails
} from '../../src/vendors/openai/image-models'

const base = 'https://developers.openai.com/api/docs/models/'
const block = (label: string, input: string, cached: string, output = '') =>
  `<div>${label} tokens</div><div>Per 1M tokens</div><div>Input</div><div class="price">$${input}</div><div>Cached input</div><div class="price">$${cached}</div>${output}`
const fixture = (name: string) =>
  `<link rel="canonical" href="${base}${name}">${block('Text', '5.00', '1.25')}${block('Image', '8.00', '2.00', '<div>Output</div><div class="price">$30.00</div>')}<div>Modalities</div><div>${name}-2026-09-08</div>`

describe('OpenAI image model pages', () => {
  test.each(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])('reads %s by modality', (name) => {
    expect(parseImageModelPage(fixture(name), name)).toEqual(imageModelSnapshot(name))
  })

  test('does not read pricing from a different canonical page', () => {
    expect(parseImageModelPage(fixture('gpt-image-2.5-flare'), 'gpt-image-2.5-sunburst')).toBeNull()
  })

  test('rejects an unknown model or a missing billable leg', () => {
    expect(parseImageModelPage(fixture('gpt-image-3'), 'gpt-image-3')).toBeNull()
    expect(parseImageModelPage(fixture('gpt-image-2.5-flare').replace('$30.00', '—'), 'gpt-image-2.5-flare')).toBeNull()
  })

  test('rejects another unit or misplaced rate instead of guessing', () => {
    const page = fixture('gpt-image-2.5-flare')
    expect(parseImageModelPage(page.replaceAll('Per 1M tokens', 'Per image'), 'gpt-image-2.5-flare')).toBeNull()
    expect(parseImageModelPage(page.replace('<div>Image tokens</div>', ''), 'gpt-image-2.5-flare')).toBeNull()
  })
})

describe('OpenAI image model refresh', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('keeps the model whose page succeeds when the other fails', async () => {
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('sunburst')) return new Response('', { status: 404 })
      return new Response(fixture('gpt-image-2.5-flare'))
    }
    const result = await refreshImageModelDetails()
    expect([...result.keys()]).toEqual(['gpt-image-2.5-flare'])
  })
})
