/**
 * Shared plumbing for the E2E suite.
 *
 * These run against the dev server that is already up; nothing here starts
 * one (CLAUDE.md: a dev server is normally already running, and a second
 * would fight it for :16175). When it cannot be reached the whole suite
 * skips itself — the same convention `HAS_DB` follows, so CI and a machine
 * with the dev server stopped do not go red.
 *
 * The browser is playwright's bundled chromium. `launch` throws where
 * `bun run browser:install` has not been run, so that is part of the skip
 * condition too.
 *
 * **Because the target is a live dev server, these can fail while someone
 * is editing.** Hitting it mid-HMR fails in the gap between rebuilds, not
 * because the implementation is wrong. On the day this suite landed, 15
 * tests failed only while another change was in flight and then passed
 * three runs in a row once the editing stopped. **A red run here should
 * first raise the question "is someone touching the tree right now" —
 * stop, then measure again.** If it stays red, it is real.
 */

import { type Browser, chromium } from 'playwright'

const configured = process.env.RIALTO_E2E_BASE_URL
export const E2E_BASE_URL = configured === undefined || configured.length === 0 ? 'http://localhost:16175' : configured

async function serverUp(): Promise<boolean> {
  if (process.env.RIALTO_SKIP_E2E === '1') return false
  try {
    // Short timeout: a trade between waiting every run when no server is
    // there, and missing one that is.
    const res = await fetch(E2E_BASE_URL, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Playwright resolves its bundled chromium by build number, so a machine
 * that has a *different* build installed — a devcontainer image that
 * pinned one, a shared cache — owns a working browser this suite cannot
 * see, and skips everything. `RIALTO_CHROMIUM_PATH` points it at that
 * binary instead — the same knob `mocks:shoot` reads.
 */
function launchOptions(): { headless: true; executablePath?: string } {
  const path = process.env.RIALTO_CHROMIUM_PATH
  if (path === undefined || path.length === 0) return { headless: true }
  return { headless: true, executablePath: path }
}

async function browserUsable(): Promise<boolean> {
  try {
    const browser = await chromium.launch(launchOptions())
    await browser.close()
    return true
  } catch {
    return false
  }
}

/**
 * Run E2E only when the server and the browser are both available. Both
 * are probed once at load because `describe.skipIf` needs its value at
 * collection time.
 */
export const HAS_E2E = (await serverUp()) && (await browserUsable())

export function launchBrowser(): Promise<Browser> {
  return chromium.launch(launchOptions())
}
