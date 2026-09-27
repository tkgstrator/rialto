/**
 * POST /v1/app/challenge — a single-use challenge for App Attest.
 * POST /v1/app/devices   — trade an attestation for an access token.
 *
 * Both are reached WITHOUT an access token: they are how an app install
 * gets one. `index.ts` mounts them ahead of the /v1 gate for that reason,
 * which makes the attestation check in `registerDevice` the only thing
 * standing in front of token issuance here. They live under /v1 because
 * that is the prefix the edge already lets clients through on; /api is
 * behind Cloudflare Access.
 *
 * Errors use the OpenAI envelope, the convention the app already parses.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { logger } from '../../logger'
import { issueChallenge, readAppDeviceConfig, registerDevice } from '../../services/app-device-service'
import { accessLog } from '../access-log'

const RegisterBodySchema = z.object({
  key_id: z.string().nonempty(),
  attestation: z.string().nonempty(),
  challenge: z.string().nonempty()
})

const error = (message: string, code: string) => ({
  error: { message, type: 'invalid_request_error', param: null, code }
})

const NOT_CONFIGURED = error('App registration is not configured on this server.', 'app_registration_disabled')

export const appDevicesRoute = new Hono()

appDevicesRoute.use('/v1/app/*', accessLog)

appDevicesRoute.post('/v1/app/challenge', (c) => {
  if (readAppDeviceConfig() === null) return c.json(NOT_CONFIGURED, 503)
  const { challenge, expiresInSeconds } = issueChallenge()
  return c.json({ challenge, expires_in: expiresInSeconds })
})

appDevicesRoute.post('/v1/app/devices', async (c) => {
  const config = readAppDeviceConfig()
  if (config === null) return c.json(NOT_CONFIGURED, 503)

  const parsed = RegisterBodySchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json(error('Send key_id, attestation and challenge as JSON strings.', 'invalid_body'), 400)
  }

  const result = await registerDevice(
    { keyId: parsed.data.key_id, attestation: parsed.data.attestation, challenge: parsed.data.challenge },
    config
  )
  if (!result.ok) {
    // The reason goes to the log, not the client: telling a forger which
    // check failed only helps them build the next attempt.
    logger.warn({ reason: result.reason }, 'app device registration refused')
    return c.json(
      error(
        result.status === 409 ? 'This key is already registered.' : 'The attestation could not be verified.',
        result.status === 409 ? 'already_registered' : 'attestation_rejected'
      ),
      result.status
    )
  }

  return c.json(
    {
      api_key: result.apiKey,
      plan: result.plan,
      model: result.model,
      daily_request_limit: result.dailyRequestLimit
    },
    201
  )
})
