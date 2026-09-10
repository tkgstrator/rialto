import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import JSON5 from 'json5'
import { type ConfigEnvelope, ConfigEnvelopeSchema } from '@/schemas/domain/config'
import { ENVELOPE_ENV_KEYS, type EnvelopeEnvKey } from '@/shared'
import { CONFIG_FILE, HOME_DIR } from '@/shared/constants'
import { SEED_PERSONAS } from '@/shared/data'
import { logger } from '../../logger'

// Function to interpolate environment variables in config values
const interpolateEnvVars = (obj: any): any => {
  if (typeof obj === 'string') {
    // Replace $VAR_NAME or ${VAR_NAME} with environment variable values
    return obj.replace(/\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/g, (match, braced, unbraced) => {
      const varName = braced || unbraced
      return process.env[varName] || match // Keep original if env var doesn't exist
    })
  } else if (Array.isArray(obj)) {
    return obj.map(interpolateEnvVars)
  } else if (obj !== null && typeof obj === 'object') {
    const result: any = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateEnvVars(value)
    }
    return result
  }
  return obj
}

// Coerce a string env value into the shape the schema expects for that
// key. Numeric / boolean fields on the envelope declare their type
// without `.coerce`, so a raw env string ("3456", "true") would fail
// schema validation without this pre-step. Unknown / stringy keys pass
// through unchanged.
const coerceEnvelopeValue = (key: EnvelopeEnvKey, value: string): unknown => {
  switch (key) {
    case 'PORT':
    case 'API_TIMEOUT_MS':
    case 'LOG_MAX_MB': {
      const n = Number(value)
      return Number.isFinite(n) ? n : value
    }
    case 'LOG':
    case 'NON_INTERACTIVE_MODE':
    case 'CAPTURE_REQUESTS':
    case 'CAPTURE_MESSAGES':
    case 'REDACT_TOOL_ARGUMENTS':
      // Only the strings the operator would reasonably type. Anything
      // else (unset, empty, arbitrary) leaves the field alone.
      return value === 'true' || value === '1'
    default:
      return value
  }
}

// 12-factor overlay: for each envelope scalar the user could reasonably
// deploy through docker-compose / systemd env, let a set process.env
// value replace whatever the disk envelope carries. Empty-string env
// values are ignored so a stray `ACCESS_AUD=` line in a .env file cannot
// blank a value the disk file sets. Runs BEFORE ConfigEnvelopeSchema
// parsing so an env value is validated exactly like a disk one.
const overlayEnvOnRaw = (raw: unknown): unknown => {
  if (raw === null || typeof raw !== 'object') return raw
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) }
  for (const key of ENVELOPE_ENV_KEYS) {
    const envValue = process.env[key]
    if (envValue === undefined || envValue === '') continue
    out[key] = coerceEnvelopeValue(key, envValue)
  }
  return out
}

const ensureDir = async (dir_path: string) => {
  try {
    await fs.access(dir_path)
  } catch {
    await fs.mkdir(dir_path, { recursive: true })
  }
}

export const initDir = async () => {
  await ensureDir(HOME_DIR)
  await ensureDir(path.join(HOME_DIR, 'logs'))
}

const createReadline = () => {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })
}

const question = (query: string): Promise<string> => {
  return new Promise((resolve) => {
    const rl = createReadline()
    rl.question(query, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

const confirm = async (query: string): Promise<boolean> => {
  const answer = await question(query)
  return answer.toLowerCase() !== 'n'
}

/**
 * Move an unusable config file aside instead of deleting it.
 *
 * A config that fails to parse or validate is still the operator's only
 * copy of their settings, and there are no backups. Unlinking it meant a
 * single bad key — including one arriving from a stray environment
 * variable — destroyed the file and every setting in it, the Cloudflare
 * Access pair included, which locks a tunnelled install's remote browsers
 * out. Renaming keeps the boot path working while leaving the original
 * recoverable.
 */
const quarantineConfigFile = async (): Promise<void> => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const aside = `${CONFIG_FILE}.invalid-${stamp}`
  try {
    await fs.rename(CONFIG_FILE, aside)
    logger.error({ from: CONFIG_FILE, to: aside }, 'Config file was unusable — moved aside, not deleted')
  } catch (err) {
    logger.error({ path: CONFIG_FILE, err }, 'Could not move the unusable config file aside')
  }
}

/**
 * Values worth carrying out of a config that failed to load.
 *
 * Personas are the one envelope-only object with no copy anywhere else —
 * Providers live in the database — so they survive the rebuild. Nothing
 * else is carried: the rest is recoverable from the file moved aside.
 */
const salvageFromRaw = (raw: unknown): Partial<{ Personas: unknown[] }> => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const obj: Record<string, unknown> = { ...raw }
  return Array.isArray(obj.Personas) && obj.Personas.length > 0 ? { Personas: obj.Personas } : {}
}

/**
 * The config a fresh install — or a quarantined one — boots with.
 *
 * It carries no credential, because there is no admin secret to mint: a
 * browser on this machine is exempt, remote admin access goes through
 * Cloudflare Access, and /v1 takes issued tokens only. This used to mint
 * an APIKEY, which meant every install shipped a master key for /api/*
 * that got past Access for anyone who read it out of config.json, a backup
 * or shell history.
 */
const createDefaultConfig = async (salvaged: ReturnType<typeof salvageFromRaw> = {}): Promise<ConfigEnvelope> => {
  await initDir()
  const raw = {
    PORT: 3456,
    Providers: [],
    // Ship a few ready-made personas in the default config so a fresh
    // install has something to pick under Settings → Personas out of the box.
    Personas: salvaged.Personas === undefined ? SEED_PERSONAS : salvaged.Personas
  }
  await writeConfigFile(raw)
  logger.info({ path: CONFIG_FILE }, 'Created default configuration file')
  // Parse through the schema so callers receive a fully-defaulted
  // ConfigEnvelope (HOST, LOG, LOG_LEVEL, PROXY_URL, …) instead of just
  // the scalars we persist on first run. Env overlay is applied to the
  // runtime value (not written to disk) so a deploy that sets PORT or the
  // Access pair through the environment still wins.
  return ConfigEnvelopeSchema.parse(overlayEnvOnRaw(raw))
}

/**
 * Read the disk config file as a raw parsed object — no schema defaults
 * applied, no env overlay, no on-disk repair. Returns `{}` when the file
 * is missing or unparseable so callers can treat "no disk state" and "no
 * matching keys" identically. Consumed by `applyUiConfig` to merge a
 * partial UI payload onto disk without losing keys the payload omitted;
 * do NOT use for runtime reads — use `readConfigFile()` for those.
 */
export const readRawConfigFile = async (): Promise<Record<string, unknown>> => {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8')
    const parsed: unknown = JSON5.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

export const readConfigFile = async (): Promise<ConfigEnvelope> => {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8')
    let parsed: unknown
    try {
      parsed = JSON5.parse(raw)
    } catch (parseError) {
      logger.error({ path: CONFIG_FILE, err: parseError }, 'Failed to parse config file')
      await quarantineConfigFile()
      // Nothing is salvageable from a file JSON5 could not read.
      return createDefaultConfig()
    }

    // Env overlay runs before schema validation so a docker-compose
    // deploy can supply a scalar purely via env, and have it validated
    // like one read from disk.
    const overlaid = overlayEnvOnRaw(parsed)
    const result = ConfigEnvelopeSchema.safeParse(overlaid)
    if (!result.success) {
      logger.error({ err: result.error }, 'Config file failed schema validation')
      await quarantineConfigFile()
      // The file parsed as JSON — one key failing validation is no
      // reason to drop the persona library, which is stored nowhere else.
      return createDefaultConfig(salvageFromRaw(parsed))
    }

    // Return the schema-parsed envelope (defaults applied, API_TIMEOUT_MS
    // coerced, …). Callers — and `initConfig` in particular — can rely on
    // typed values without re-parsing.
    return interpolateEnvVars(result.data)
  } catch (readError: any) {
    if (readError.code === 'ENOENT') {
      try {
        return await createDefaultConfig()
      } catch (error: any) {
        logger.fatal({ err: error }, 'Failed to create default configuration')
        process.exit(1)
      }
    } else {
      logger.fatal({ path: CONFIG_FILE, err: readError }, 'Failed to read config file')
      process.exit(1)
    }
    // Unreachable: every branch above either returns or process.exit's.
    throw readError
  }
}

export const writeConfigFile = async (config: any) => {
  await ensureDir(HOME_DIR)
  const configWithComment = `${JSON.stringify(config, null, 2)}`
  await fs.writeFile(CONFIG_FILE, configWithComment)
}

/**
 * Mirror the envelope's scalar keys onto process.env so downstream
 * consumers that still read `process.env.PORT` etc. keep working.
 *
 * The legacy implementation did `Object.assign(process.env, config)` —
 * fine for strings but it stringified nested Providers/Router objects
 * to `[object Object]` (and we no longer want those on disk anyway).
 * Whitelisting the keys here lets us tighten the contract without
 * breaking any caller that legitimately reads e.g. process.env.PROXY_URL.
 *
 * Present keys are set; keys ABSENT from the envelope (undefined / null)
 * are DELETED from process.env. Without the delete side, a UI-driven
 * scalar removal (or a change from any earlier value) would linger on
 * process.env forever and be silently reasserted over the new disk
 * state by overlayEnvOnRaw on the next read — the reason LOG_LEVEL
 * appeared to "always reset to info" after saving from the UI.
 */
export const applyEnvelopeToEnv = (config: Record<string, unknown>) => {
  for (const key of ENVELOPE_ENV_KEYS) {
    const value = config[key]
    if (value === undefined || value === null) {
      delete process.env[key]
      continue
    }
    if (typeof value === 'string') process.env[key] = value
    else if (typeof value === 'number' || typeof value === 'boolean') process.env[key] = String(value)
    // Anything else (object/array) is silently skipped — those keys
    // don't belong on process.env in the first place.
  }
}

/**
 * One-time, idempotent migration to the uuid-keyed persona model.
 *
 * Older configs stored personas as { name, prompt } and referenced the
 * active one by name (ActivePersona). The library is now keyed by a
 * stable uuid `id`: this backfills an `id` onto every persona that lacks
 * one and rewrites a name-based ActivePersona to the matching persona's
 * id. Operates on the raw on-disk JSON (not the schema-parsed envelope)
 * so it only rewrites Personas/ActivePersona and leaves the rest of the
 * file shape untouched. No-ops once every persona already has an id, so
 * it is safe to run on every boot. Stays silent on a missing/unparsable
 * file — readConfigFile owns those paths (create-default / wipe).
 */
const migratePersonaKeys = async (): Promise<void> => {
  let raw: string
  try {
    raw = await fs.readFile(CONFIG_FILE, 'utf-8')
  } catch {
    return
  }
  let parsed: any
  try {
    parsed = JSON5.parse(raw)
  } catch {
    return
  }
  const personas = Array.isArray(parsed?.Personas) ? parsed.Personas : []
  let changed = false
  for (const persona of personas) {
    if (persona !== null && typeof persona === 'object' && typeof persona.id !== 'string') {
      persona.id = crypto.randomUUID()
      changed = true
    }
  }
  // Rewrite a name-based active selection to the matching persona's id.
  const active = parsed?.ActivePersona
  if (typeof active === 'string' && active !== '' && !personas.some((p: any) => p?.id === active)) {
    const match = personas.find((p: any) => p?.name === active)
    if (match !== undefined) {
      parsed.ActivePersona = match.id
      changed = true
    }
  }
  if (changed) {
    await writeConfigFile(parsed)
    logger.info({ path: CONFIG_FILE }, 'Migrated personas to uuid keys')
  }
}

export const initConfig = async (): Promise<ConfigEnvelope> => {
  await migratePersonaKeys()
  const envelope = await readConfigFile()
  applyEnvelopeToEnv(envelope)
  return envelope
}
