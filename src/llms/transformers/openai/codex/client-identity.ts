/**
 * How a request to the Codex backend identifies itself: the markers Codex
 * CLI 0.158.0 sends, captured from `codex exec` against a local server.
 *
 * The ChatGPT backend tells a CLI request (subscription allotment) from any
 * other (overage) by these markers. Rialto presents itself as `codex exec`,
 * the CLI's non-interactive mode — a server making one-shot turns is
 * exactly that — rather than the TUI (`codex-tui`), and with no terminal,
 * which `codex exec` reports as `unknown`.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { arch } from 'node:os'
import { v7 } from 'uuid'
import dayjs from '@/lib/dayjs'
import { PackageJsonSchema } from '@/schemas/wire'

export const CODEX_ORIGINATOR = 'codex_exec'

// The beta features the CLI has enabled, sent on every request; 0.158.0's
// default set.
const CODEX_BETA_FEATURES = 'remote_compaction_v2'

const safe = (fn: () => string, fallback: string): string => {
  try {
    const value = fn().trim()
    return value.length > 0 ? value : fallback
  } catch {
    return fallback
  }
}

// CODEX_CLI_VERSION env (lets prod pin it if @openai/codex is ever pruned)
// -> the installed @openai/codex package -> "0.0.0".
const CODEX_CLI_VERSION: string = (() => {
  const pinned = (process.env.CODEX_CLI_VERSION ? process.env.CODEX_CLI_VERSION : '').trim()
  if (pinned.length > 0) return pinned
  return safe(() => {
    const pkg = PackageJsonSchema.safeParse(createRequire(import.meta.url)('@openai/codex/package.json'))
    if (!pkg.success) throw new Error('@openai/codex/package.json: missing version field')
    return pkg.data.version
  }, '0.0.0')
})()

// The CLI names the OS through the `os_info` crate. Its names for the
// distributions a Rialto image is built on, by /etc/os-release ID; any other
// falls back to the file's own NAME.
const OS_NAMES = new Map([
  ['ubuntu', 'Ubuntu'],
  ['debian', 'Debian'],
  ['alpine', 'Alpine Linux'],
  ['fedora', 'Fedora'],
  ['arch', 'Arch Linux']
])

// `os_info` reads a numeric version as three numbers, so Ubuntu's "22.04"
// is sent as "22.4.0" (measured) and Debian's "12" as "12.0.0".
function osVersion(raw: string): string {
  const parts = raw.split('.')
  if (parts.length > 3 || !parts.every((part) => /^\d+$/.test(part))) return raw
  return [...parts, '0', '0']
    .slice(0, 3)
    .map((part) => String(Number(part)))
    .join('.')
}

const OS_STRING: string = safe(() => {
  const release = readFileSync('/etc/os-release', 'utf-8')
  const field = (key: string): string => {
    const match = release.match(new RegExp(`^${key}="?([^"\\n]+)"?`, 'm'))
    return match ? match[1] : ''
  }
  const known = OS_NAMES.get(field('ID'))
  const name = known !== undefined ? known : field('NAME')
  const version = field('VERSION_ID')
  return `${name.length > 0 ? name : 'Linux'} ${version.length > 0 ? osVersion(version) : ''}`
}, 'Linux')

// Rust's names for the architecture, which is what the CLI reports.
const RUST_ARCH = new Map([
  ['x64', 'x86_64'],
  ['arm64', 'aarch64']
])
const rustArch = RUST_ARCH.get(arch())
const ARCH_STRING = rustArch === undefined ? arch() : rustArch

// `codex_exec/0.158.0 (Ubuntu 22.4.0; aarch64) unknown (codex_exec; 0.158.0)`
// as captured with no TERM set. Resolved once at boot; never throws.
export const CODEX_USER_AGENT = `${CODEX_ORIGINATOR}/${CODEX_CLI_VERSION} (${OS_STRING}; ${ARCH_STRING}) unknown (${CODEX_ORIGINATOR}; ${CODEX_CLI_VERSION})`

// A UUID that is the same every time for the same seed. The CLI keeps its
// installation id in CODEX_HOME and its context-window id for the life of
// a thread; Rialto keeps neither, and derives them instead.
function stableUuid(kind: string, seed: string): string {
  const bytes = createHash('sha256').update(`rialto-codex-${kind}:${seed}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export type CodexTurn = {
  threadId: string
  // The subscription account the request runs on. Each is a separate
  // ChatGPT login, as a separate machine running the CLI would be, so each
  // gets an installation id of its own.
  subAccountId: string | undefined
  model: string | undefined
  effort: string | undefined
}

/**
 * The per-turn markers: headers, and the same facts again as the body's
 * `client_metadata`. Field order in the metadata JSON is the CLI's.
 *
 * The sandbox fields say what `codex exec` says with no sandbox, which is
 * the truth here: Rialto runs nothing the model asks for.
 */
export function codexTurnIdentity(turn: CodexTurn): {
  headers: Record<string, string>
  clientMetadata: Record<string, string>
} {
  const installationId = stableUuid('installation', turn.subAccountId === undefined ? 'default' : turn.subAccountId)
  const turnId = v7()
  const windowId = `${turn.threadId}:0`
  const metadata = JSON.stringify({
    installation_id: installationId,
    session_id: turn.threadId,
    thread_id: turn.threadId,
    agent_name: '/root',
    turn_id: turnId,
    window_id: windowId,
    window_number: 0,
    context_window_id: stableUuid('context-window', turn.threadId),
    request_kind: 'turn',
    root_turn_id: turnId,
    thread_source: 'user',
    turn_trigger: 'exec',
    sandbox: 'none',
    sandbox_mode: 'danger-full-access',
    auto_review_enabled: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    turn_started_at_unix_ms: dayjs().valueOf(),
    analytics_enabled: true,
    ...(turn.model === undefined ? {} : { model: turn.model }),
    ...(turn.effort === undefined ? {} : { reasoning_effort: turn.effort })
  })
  return {
    headers: {
      // The CLI sends its thread id as the request id too.
      'session-id': turn.threadId,
      'thread-id': turn.threadId,
      'x-client-request-id': turn.threadId,
      'x-codex-beta-features': CODEX_BETA_FEATURES,
      'x-codex-turn-metadata': metadata,
      'x-codex-window-id': windowId
    },
    clientMetadata: {
      'x-codex-installation-id': installationId,
      session_id: turn.threadId,
      thread_id: turn.threadId,
      turn_id: turnId,
      root_turn_id: turnId,
      'x-codex-window-id': windowId,
      'x-codex-turn-metadata': metadata
    }
  }
}
