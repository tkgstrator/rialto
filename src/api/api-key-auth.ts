import type { MiddlewareHandler } from 'hono'
import './context'
import { catalogPathFor, type SurfaceAuth, type SurfaceErrorShape, surfaceForPath } from '../llms/inbound/surfaces'
import { noteTokenUse, resolveAccessToken } from '../services/access-token-service'
import { readAccessConfig, verifyAccessJwt } from '../services/cloudflare-access'
import { isLocalRequest } from './local-access'

interface ApiKeyAuthOptions {
  // Which credential convention this surface accepts. Deliberately one
  // per surface: `x-api-key` is Anthropic's, `Authorization: Bearer` is
  // OpenAI's, `x-goog-api-key` / `?key=` are Google's, and accepting a
  // neighbouring convention leaks them into each other — an operator
  // then reuses one key across two surfaces and cannot tell which
  // client a revocation will cut off.
  credential?: SurfaceAuth
  // Error envelope shape. Anthropic-style clients (Claude Code) expect
  // `{type: 'error', error: {type, message}}`; OpenAI SDK / Codex CLI /
  // Cline expect `{error: {message, type, code}}`; Google clients expect
  // `{error: {code, message, status}}`. The wire body diverges even
  // though the 401 status is identical.
  errorShape?: SurfaceErrorShape
}

function unauthorizedResponse(
  shape: SurfaceErrorShape,
  // The proxy and the admin API fail for different reasons and have
  // different remedies, and the operator reads this text in a CLI where
  // it is the only diagnostic they get.
  message: string
): {
  status: 401
  body: Record<string, unknown>
} {
  if (shape === 'openai') {
    return {
      status: 401,
      body: {
        error: { message, type: 'invalid_request_error', param: null, code: 'invalid_api_key' }
      }
    }
  }
  if (shape === 'google') {
    return {
      status: 401,
      body: { error: { code: 401, message, status: 'UNAUTHENTICATED' } }
    }
  }
  return {
    status: 401,
    body: { type: 'error', error: { type: 'authentication_error', message } }
  }
}

const PROXY_UNAUTHORIZED =
  'Invalid, revoked or expired access token. Issue one on the Access tokens page and send it as Authorization: Bearer <token>.'

const PROXY_WRONG_SURFACE = 'This access token is not scoped to this endpoint.'

// There is no admin credential a caller could have sent instead, so the
// refusal names the two ways in rather than asking for a key.
const ADMIN_UNAUTHORIZED =
  'Not a request from the machine Rialto runs on, and no verified Cloudflare Access assertion. Open Rialto on that machine, or through your Access application.'

// Pull the presented secret off whichever header this surface accepts.
// Fails closed: an absent or unreadable credential returns the empty
// string, which matches nothing.
//
// Bearer is read on every convention: it is the one header all three
// client families can send. The convention only decides which ADDITIONAL
// header is read — `x-api-key` for Anthropic callers, `x-goog-api-key` /
// `?key=` for Google ones — so a caller never gets in by presenting a
// neighbouring surface's header.
function presentedSecret(c: Parameters<MiddlewareHandler>[0], credential: SurfaceAuth): string {
  const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
  const xApiKey = credential === 'x-api-key' ? c.req.header('x-api-key') : undefined
  // Google's own SDKs send `x-goog-api-key`; its REST docs send `?key=`.
  // The query form is read on this surface only: a URL-borne secret leaks
  // through access logs, browser history and the Referer header, and
  // Google's convention is the one that leaves no alternative. `accessLog`
  // logs `c.req.path`, never the query, so the token does not reach the
  // log file from here.
  const googKey = credential === 'google' ? (c.req.header('x-goog-api-key') ?? c.req.query('key')) : undefined
  return (xApiKey ?? googKey ?? bearer ?? '').trim()
}

/**
 * Gate for /api/* — the admin surface.
 *
 * Two ways in, and no credential of its own:
 *
 * - A request made on the machine Rialto runs on (`local-access.ts`),
 *   which presents nothing.
 * - A Cloudflare Access assertion, once ACCESS_TEAM_DOMAIN and ACCESS_AUD
 *   are set: the edge authenticates a human and forwards a signed
 *   assertion, which is verified here against the team JWKS. The header is
 *   never trusted on its own, because an origin reachable directly can be
 *   handed a forged one.
 *
 * There used to be a third, the envelope `APIKEY`, kept as the way back in
 * when Access or Postgres was down. It was a master key for /api/* that
 * got past Access for whoever read it out of config.json, a backup or
 * shell history — and both outages already have a way back in that needs
 * no secret. The local exemption reads neither Access nor the database, so
 * an operator who can reach the host (an SSH port-forward will do) can
 * always reach the admin UI.
 */
export const adminAuth: MiddlewareHandler = async (c, next) => {
  // A browser on the machine Rialto runs on does not have to
  // authenticate to itself. See local-access.ts for why the test is not
  // simply "is the peer loopback" — with a tunnel in front, it always is.
  if (isLocalRequest(c)) {
    c.set('authVia', 'local')
    return next()
  }

  const config = readAccessConfig()
  const assertion = c.req.header('cf-access-jwt-assertion')
  if (config !== null && typeof assertion === 'string' && assertion.length > 0) {
    const identity = await verifyAccessJwt(assertion, config)
    if (identity !== null) {
      c.set('authVia', 'cloudflare_access')
      c.set('accessEmail', identity.email)
      return next()
    }
  }

  const err = unauthorizedResponse('anthropic', ADMIN_UNAUTHORIZED)
  return c.json(err.body, err.status)
}

/**
 * Gate for /v1/* — the billable proxy. Issued tokens only.
 *
 * At the edge this path is a Bypass policy, because CLI clients cannot do
 * an interactive Access login — so whatever this middleware accepts is
 * the only thing standing in front of the operator's subscription and
 * API credits. An issued token can be revoked on its own and is recorded
 * against every request it makes, which is the whole reason tokens exist;
 * nothing else opens this path.
 *
 * The consequence is that a fresh install cannot proxy until a token is
 * issued. That is the intended shape: closed until someone decides who
 * may call.
 *
 * The resolved token is stashed on the context for the route to record
 * against the request and to read its routing scope from.
 */
export function createProxyAuth(options: ApiKeyAuthOptions = {}): MiddlewareHandler {
  const credential: SurfaceAuth = options.credential !== undefined ? options.credential : 'x-api-key'
  const errorShape: SurfaceErrorShape = options.errorShape !== undefined ? options.errorShape : 'anthropic'
  return async (c, next) => {
    const provided = presentedSecret(c, credential)
    const token = provided.length === 0 ? null : await resolveAccessToken(provided)
    if (token === null) {
      const err = unauthorizedResponse(errorShape, PROXY_UNAUTHORIZED)
      return c.json(err.body, err.status)
    }

    // A token pinned to a set of surfaces must not reach one outside it.
    // Checked here rather than in the route so no handler can forget it.
    // An empty list is "not pinned".
    //
    // Catalog paths are exempt. `/v1/models` and
    // `/v1/messages/count_tokens` are not completion surfaces — they
    // spend nothing and are deliberately outside the registry — so
    // `surfaceForPath` cannot name them and a scoped token was refused
    // on all of them. An OpenAI SDK client lists models before it calls
    // one, which made "scoped to /v1/chat/completions" mean "cannot use
    // the OpenAI SDK". The scope says which surfaces may be *called*;
    // it says nothing about reading the menu. If a token ever gains a
    // model restriction, the answer here is to filter the listing, not
    // to refuse it.
    //
    // Anywhere else the registry cannot name stays a rejection for a
    // pinned token: "not one of the surfaces you were given" is the
    // right answer for a path nothing claims.
    const reached = surfaceForPath(c.req.path)
    const catalogRead = catalogPathFor(c.req.path) !== undefined
    if (!catalogRead && token.surfaces.length > 0 && (reached === undefined || !token.surfaces.includes(reached.id))) {
      const err = unauthorizedResponse(errorShape, PROXY_WRONG_SURFACE)
      return c.json(err.body, err.status)
    }

    c.set('accessToken', token)
    noteTokenUse(token.id)
    return next()
  }
}

export const proxyAuth: MiddlewareHandler = createProxyAuth()

// OpenAI-compat surface: reject x-api-key (an Anthropic convention) and
// emit an OpenAI-shape error envelope on 401.
export const openaiProxyAuth: MiddlewareHandler = createProxyAuth({ credential: 'bearer', errorShape: 'openai' })

// Google surface: accept `x-goog-api-key` / `?key=`, and answer 401 in
// google.rpc.Status shape so the GenAI SDKs can classify it.
export const googleProxyAuth: MiddlewareHandler = createProxyAuth({ credential: 'google', errorShape: 'google' })

// One gate per credential convention. The registry says which
// convention a surface speaks; this is the only place that turns that
// answer into a middleware, so a new descriptor picks up the right gate
// with no edit here or in index.ts.
const GATE_BY_CREDENTIAL: Record<SurfaceAuth, MiddlewareHandler> = {
  'x-api-key': proxyAuth,
  bearer: openaiProxyAuth,
  google: googleProxyAuth
}

/**
 * The proxy front door, mounted once per prefix in `index.ts`.
 *
 * Replaces the path list that used to live there — `/v1/chat/completions`,
 * `/v1/responses` and `/v1/models` named one by one, with a `/v1/*`
 * catch-all underneath. That list was a fourth copy of surface
 * knowledge, and because Hono runs every matching middleware, a valid
 * Bearer call on an OpenAI surface was authenticated twice (and its
 * token's requestCount incremented twice). Dispatching on the registry
 * fixes both.
 *
 * Fails closed: a path in neither registry gets the Anthropic-convention
 * gate, which is what the old `/v1/*` catch-all gave it.
 */
export const inboundProxyAuth: MiddlewareHandler = (c, next) => {
  const path = c.req.path
  const surface = surfaceForPath(path)
  if (surface !== undefined) return GATE_BY_CREDENTIAL[surface.auth](c, next)
  const catalog = catalogPathFor(path)
  if (catalog !== undefined) return GATE_BY_CREDENTIAL[catalog.auth](c, next)
  return proxyAuth(c, next)
}
