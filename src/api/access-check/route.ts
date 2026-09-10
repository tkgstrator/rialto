/**
 * POST /api/access-check — dry-run a Cloudflare Access configuration.
 *
 * Exists because the settings that enable Access are the settings that
 * can lock you out of the screen you set them on. `adminAuth` has
 * nothing to fall back on when an assertion fails to verify — there is
 * no admin secret — so a mistyped team domain or AUD, once saved, rejects
 * every remote browser request, and the only way back is a browser on the
 * host itself or editing the config file by hand.
 *
 * So: check first, save second. Nothing here is persisted.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  decodeSegment,
  normalizeTeamDomain,
  resetAccessKeyCache,
  verifyAccessJwt
} from '../../services/cloudflare-access'
import '../context'

const BodySchema = z
  .object({
    teamDomain: z.string().nonempty(),
    aud: z.string().nonempty()
  })
  .openapi('AccessCheckRequest')

const ResponseSchema = z
  .object({
    // Does the team domain publish a JWKS? Catches a mistyped domain,
    // which is the failure that cannot be recovered from the browser.
    jwksReachable: z.boolean(),
    keyCount: z.number().int().nonnegative(),
    // Whether THIS request carried an Access assertion. False when the
    // operator is still reaching the origin directly, in which case the
    // audience cannot be checked yet and saving is a leap of faith.
    assertionPresent: z.boolean(),
    // Whether that assertion verifies against the proposed settings.
    // Null when there was no assertion to check.
    assertionValid: z.boolean().nullable(),
    email: z.string().nonempty().nullable(),
    // Plain-language verdict for the UI to show verbatim.
    detail: z.string().nonempty()
  })
  .openapi('AccessCheckResponse')

export const accessCheckRoute = new OpenAPIHono()

const DetectSchema = z
  .object({
    // Whether this request arrived through Cloudflare Access at all.
    // False means there is nothing to read and the operator has to fetch
    // the values from the Zero Trust dashboard.
    assertionPresent: z.boolean(),
    teamDomain: z.string().nonempty().nullable(),
    aud: z.string().nonempty().nullable(),
    email: z.string().nonempty().nullable(),
    detail: z.string().nonempty()
  })
  .openapi('AccessDetectResponse')

/**
 * GET /api/access-check/detect — read the settings off the request.
 *
 * The team domain and AUD tag are otherwise a hunt through the Zero
 * Trust dashboard, and a mistyped AUD is the failure that locks the
 * operator out of the screen they typed it on. When the request already
 * came through Access, both values are sitting in the assertion.
 *
 * NOT verified — it cannot be, since verifying requires knowing the
 * team domain, which is what is being read. These are suggestions to
 * put in the fields; POST /api/access-check then verifies them properly
 * against the JWKS that domain publishes. The operator should recognise
 * the team domain before trusting it, which is why it is reported
 * rather than silently applied.
 */
accessCheckRoute.openapi(
  createRoute({
    method: 'get',
    path: '/api/access-check/detect',
    responses: {
      200: {
        description: 'Unverified Access settings read off this request, to prefill the fields',
        content: { 'application/json': { schema: DetectSchema } }
      }
    }
  }),
  (c) => {
    const assertion = c.req.header('cf-access-jwt-assertion')
    const parts = typeof assertion === 'string' ? assertion.split('.') : []
    const claims = parts.length === 3 ? decodeSegment(parts[1]) : null

    if (claims === null || typeof claims !== 'object') {
      return c.json(
        {
          assertionPresent: false,
          teamDomain: null,
          aud: null,
          email: null,
          detail:
            'This request did not come through Cloudflare Access, so there is nothing to read. Open Rialto on the hostname Access protects, or copy the team domain and Application Audience (AUD) tag from the Zero Trust dashboard.'
        },
        200
      )
    }

    const record: Record<string, unknown> = { ...claims }
    const iss = typeof record.iss === 'string' ? record.iss : null
    const audValue = record.aud
    // Cloudflare sends `aud` as an array; a token minted for several
    // applications would carry several, and guessing which one this
    // deployment is would be worse than asking.
    const auds = Array.isArray(audValue) ? audValue.filter((a): a is string => typeof a === 'string') : []
    const single = typeof audValue === 'string' ? audValue : auds.length === 1 ? auds[0] : null
    const email = typeof record.email === 'string' ? record.email : null

    return c.json(
      {
        assertionPresent: true,
        teamDomain: iss === null ? null : normalizeTeamDomain(iss),
        aud: single,
        email,
        detail:
          single === null && auds.length > 1
            ? `This assertion carries ${auds.length} audience tags, so the right one is ambiguous — pick this application's AUD from the Zero Trust dashboard.`
            : 'Read from the Access assertion on this request. Not verified yet — run the check to confirm it against the keys that domain publishes.'
      },
      200
    )
  }
)

accessCheckRoute.openapi(
  createRoute({
    method: 'post',
    path: '/api/access-check',
    request: { body: { content: { 'application/json': { schema: BodySchema } } } },
    responses: {
      200: {
        description: 'Whether these settings would work. Nothing is saved.',
        content: { 'application/json': { schema: ResponseSchema } }
      }
    }
  }),
  async (c) => {
    const { teamDomain, aud } = c.req.valid('json')
    // The same normaliser the runtime uses. Checking one string and
    // running another is how a configuration passes here and locks the
    // operator out afterwards.
    const domain = normalizeTeamDomain(teamDomain)

    const certs = await fetch(`https://${domain}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(5000)
    }).catch(() => null)

    const keys =
      certs !== null && certs.ok
        ? await certs
            .json()
            .then((body: unknown) =>
              body !== null && typeof body === 'object' && Array.isArray(Reflect.get(body, 'keys'))
                ? Reflect.get(body, 'keys').length
                : 0
            )
            .catch(() => 0)
        : 0

    if (certs === null || !certs.ok || keys === 0) {
      return c.json(
        {
          jwksReachable: false,
          keyCount: 0,
          assertionPresent: false,
          assertionValid: null,
          detail: `No signing keys published at ${domain}. Check the team domain — it looks like <team>.cloudflareaccess.com. Saving this would reject every browser request.`,
          email: null
        },
        200
      )
    }

    const assertion = c.req.header('cf-access-jwt-assertion')
    if (typeof assertion !== 'string' || assertion.length === 0) {
      return c.json(
        {
          jwksReachable: true,
          keyCount: keys,
          assertionPresent: false,
          assertionValid: null,
          detail: `The team domain is valid and publishes ${keys} signing keys, but this request did not arrive through Access, so the AUD tag could not be checked. Reach this page through the Access-protected hostname to verify it before relying on it.`,
          email: null
        },
        200
      )
    }

    // Verify the caller's own assertion against the proposed settings.
    // Cached keys are dropped first so a domain typed a moment ago is
    // fetched rather than answered from a previous attempt.
    resetAccessKeyCache()
    const identity = await verifyAccessJwt(assertion, { teamDomain: domain, aud })
    resetAccessKeyCache()

    return c.json(
      {
        jwksReachable: true,
        keyCount: keys,
        assertionPresent: true,
        assertionValid: identity !== null,
        email: identity?.email === undefined ? null : identity.email,
        detail:
          identity === null
            ? 'Your own Access assertion does NOT verify against these settings — most likely the AUD tag belongs to a different application. Saving this would lock you out of this screen.'
            : `Verified. Your assertion checks out against these settings${identity.email === null ? '' : ` as ${identity.email}`}, so saving them is safe.`
      },
      200
    )
  }
)
