import { afterEach, expect, test } from 'bun:test'
import { api } from '../../src/lib/api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const respondWith = (response: () => Response) => {
  const stub = async () => response()
  globalThis.fetch = Object.assign(stub, { preconnect: originalFetch.preconnect })
}

const failWith = (body: unknown, status = 400) => respondWith(() => Response.json(body, { status }))

test('formats validation issues with their array paths', async () => {
  failWith({
    success: false,
    error: {
      type: 'validation_error',
      issues: [
        { path: ['surfaces', 1], message: 'Invalid option: expected openai-images' },
        { path: ['name'], message: 'Required' }
      ]
    }
  })
  await expect(api.get('/anything')).rejects.toThrow(
    'surfaces[1]: Invalid option: expected openai-images\nname: Required'
  )
})

test('preserves string and nested-message API errors', async () => {
  failWith({ error: 'Not found' }, 404)
  await expect(api.get('/anything')).rejects.toThrow('Not found')
  failWith({ error: { message: 'Upstream unavailable' } }, 502)
  await expect(api.get('/anything')).rejects.toThrow('Upstream unavailable')
})

test('uses status fallback for unknown error objects and non-JSON bodies', async () => {
  failWith({ error: { unexpected: true } })
  await expect(api.get('/anything')).rejects.toThrow('API request failed: 400')
  respondWith(() => new Response('not JSON', { status: 400 }))
  await expect(api.get('/anything')).rejects.toThrow('API request failed: 400')
})
