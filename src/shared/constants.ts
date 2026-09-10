import os from 'node:os'
import path from 'node:path'

/**
 * Resolve the on-disk home directory from an environment.
 *
 * RIALTO_HOME_DIR lets the test preload point the config envelope at a
 * tmp directory: os.homedir() doesn't honour $HOME after the process
 * starts (it reads /etc/passwd) so setting process.env.HOME at preload
 * time is too late. Production never sets it.
 *
 * Exported as a function purely so the resolution is testable — HOME_DIR
 * itself is frozen at import time.
 *
 * The pre-rename CCR_HOME_DIR is no longer read. It was a deliberate
 * choice to drop it: unlike a credential, pointing at the wrong home is
 * self-announcing — the server comes up on an empty configuration and
 * the operator sees it immediately.
 */
export const resolveHomeDir = (env: NodeJS.ProcessEnv, homedir: string): string => {
  const pinned = env.RIALTO_HOME_DIR
  // Length-checked, not just null-checked: an exported-but-empty
  // RIALTO_HOME_DIR would otherwise resolve the home to '' and scatter
  // config.json and the log directory over the process's cwd.
  if (typeof pinned === 'string' && pinned.length > 0) return pinned
  return path.join(homedir, '.rialto')
}

export const HOME_DIR = resolveHomeDir(process.env, os.homedir())

export const CONFIG_FILE = path.join(HOME_DIR, 'config.json')

// Where pino's rotating file sink writes. Shared with the storage
// report, which measures the same directory the logger fills.
export const LOG_DIR = path.join(HOME_DIR, 'logs')
