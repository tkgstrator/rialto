/**
 * Gate logic for the two settings that can lock an operator out.
 *
 * `adminAuth` has nothing to fall back on once an assertion is present but
 * fails to verify: there is no admin secret. So a wrong team domain or
 * AUD, once saved, rejects every remote browser request, and the only way
 * back is a browser on the host itself or editing config.json by hand. The
 * save is therefore gated on a dry run, and this module decides what a
 * given dry-run result permits.
 *
 * Kept pure and separate from the component because "may this be saved"
 * is exactly the decision worth pinning in tests.
 */

/** The wire shape of POST /api/access-check. */
export interface AccessCheckResponse {
  jwksReachable: boolean
  keyCount: number
  assertionPresent: boolean
  assertionValid: boolean | null
  email: string | null
  /** Written for display; render verbatim. */
  detail: string
}

export interface AccessInput {
  teamDomain: string
  aud: string
}

/**
 * Normalise to exactly the string the runtime will use.
 *
 * This is load-bearing, not tidiness. `/api/access-check` strips a
 * leading `https://` before testing the domain, but `readAccessConfig`
 * strips only trailing slashes — so `https://team.cloudflareaccess.com`
 * passes the check and then makes the runtime fetch
 * `https://https://team…/cdn-cgi/access/certs`, which fails, which
 * rejects every admin request. Normalising here means the checked string
 * and the saved string are the same string, closing that gap.
 */
export function normalizeAccessInput(input: AccessInput): AccessInput {
  return {
    teamDomain: input.teamDomain
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, ''),
    aud: input.aud.trim()
  }
}

export function sameAccessInput(a: AccessInput, b: AccessInput): boolean {
  return a.teamDomain === b.teamDomain && a.aud === b.aud
}

export type SaveGate = { allowed: true; caveat: string | null } | { allowed: false; reason: string }

const BOTH_REQUIRED =
  'Both values are required. One alone enables nothing — verifying a signature without checking the audience would accept a token minted for any other application on your team — so a half-filled pair would silently leave this install unprotected.'

const NEEDS_CHECK =
  'Check these settings before saving. A wrong value here rejects every browser request, including yours.'

const TURNS_OFF =
  'Both fields are empty, so saving turns Access off — afterwards only a browser on this machine can reach /api/*.'

/**
 * May this draft be saved?
 *
 * `checkedFor` is the input the result in `check` was produced against.
 * It is compared rather than trusted: a verdict for a previous domain
 * must never authorise saving a newly typed one, which is the obvious
 * way a check-then-save flow gets quietly defeated.
 */
export function accessSaveGate(
  draft: AccessInput,
  check: AccessCheckResponse | null,
  checkedFor: AccessInput | null
): SaveGate {
  const hasDomain = draft.teamDomain.length > 0
  const hasAud = draft.aud.length > 0

  // Turning Access off cannot lock anyone out of the host — it is the
  // recovery direction — so it needs no dry run.
  if (!hasDomain && !hasAud) return { allowed: true, caveat: TURNS_OFF }
  if (!hasDomain || !hasAud) return { allowed: false, reason: BOTH_REQUIRED }

  if (check === null || checkedFor === null || !sameAccessInput(draft, checkedFor)) {
    return { allowed: false, reason: NEEDS_CHECK }
  }

  // A domain that publishes no keys is the unrecoverable one.
  if (!check.jwksReachable) return { allowed: false, reason: check.detail }
  // Our own assertion failing against these settings is proof of lockout.
  if (check.assertionValid === false) return { allowed: false, reason: check.detail }
  // Domain good, but nothing to check the audience against yet.
  if (!check.assertionPresent) return { allowed: true, caveat: check.detail }
  return { allowed: true, caveat: null }
}

export type CheckTone = 'ok' | 'warn' | 'bad'

/** How the verdict should read. Mirrors the gate so the two cannot disagree. */
export function checkTone(check: AccessCheckResponse): CheckTone {
  if (!check.jwksReachable) return 'bad'
  if (check.assertionValid === false) return 'bad'
  if (!check.assertionPresent) return 'warn'
  return 'ok'
}
