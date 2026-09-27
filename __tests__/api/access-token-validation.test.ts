import { expect, test } from 'bun:test'
import { accessTokensRoute } from '../../src/api/access-tokens/route'

const send = (method: string, path: string, body: unknown): Promise<Response> =>
  accessTokensRoute.fetch(
    new Request(`http://local${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  )

test('invalid token surface returns structured JSON issues', async () => {
  const response = await send('POST', '/api/access-tokens', {
    name: 'test',
    surfaces: ['openai-chat', 'not-a-surface']
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    success: false,
    error: { type: 'validation_error', issues: [{ path: ['surfaces', 1], code: 'invalid_value' }] }
  })
})

test('invalid update surface returns structured JSON issues', async () => {
  const response = await send('PATCH', '/api/access-tokens/missing', { surfaces: ['openai-images', 'not-a-surface'] })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    success: false,
    error: { type: 'validation_error', issues: [{ path: ['surfaces', 1], code: 'invalid_value' }] }
  })
})
