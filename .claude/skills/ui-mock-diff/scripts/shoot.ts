/**
 * Screenshot the mocks and/or the React implementation at Retina scale.
 *
 * Both sides are captured through the same browser, same viewport, same
 * deviceScaleFactor and the same animation freeze, so any pixel that
 * differs is a real design difference rather than a capture artefact.
 *
 *   bun run .claude/skills/ui-mock-diff/scripts/shoot.ts
 *   ... --screen routing --side mock --theme dark
 *
 * Output: mocks/.shots/<screen>.<theme>.<side>.png
 *
 * Never starts a dev server. The impl side requires one already listening
 * on `baseUrl` (mocks.json); if it is not, that side is reported as
 * skipped rather than silently producing a blank frame.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Page } from 'playwright'

const ROOT = resolve(import.meta.dir, '../../../..')
const MOCKS = join(ROOT, 'mocks')
const SHOTS = join(MOCKS, '.shots')

interface Screen {
  name: string
  mock: string
  route: string | null
  note?: string
}
interface Config {
  baseUrl: string
  viewport: { width: number; height: number }
  deviceScaleFactor: number
  themes: string[]
  screens: Screen[]
}

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  return i === -1 ? undefined : process.argv[i + 1]
}

// Kill every transition, animation and caret so two captures of the same
// DOM are byte-identical. Without this the diff is dominated by a
// half-finished hover transition or a blinking cursor.
const FREEZE = `
  *, *::before, *::after {
    transition: none !important;
    animation: none !important;
    caret-color: transparent !important;
  }
  html { scroll-behavior: auto !important; }
`

const applyTheme = async (page: Page, theme: string): Promise<void> => {
  await page.evaluate((t) => {
    document.documentElement.classList.toggle('dark', t === 'dark')
    document.documentElement.style.colorScheme = t
  }, theme)
}

const settle = async (page: Page): Promise<void> => {
  await page.addStyleTag({ content: FREEZE })
  // Inter / Geist Mono are variable webfonts; capturing before they land
  // measures a fallback-font layout and every text box reads as a diff.
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(150)
}

const main = async (): Promise<void> => {
  const config: Config = JSON.parse(await readFile(join(MOCKS, 'mocks.json'), 'utf8'))
  const onlyScreen = arg('--screen')
  const side = arg('--side') ?? 'both'
  const themeArg = arg('--theme') ?? 'both'
  const themes = themeArg === 'both' ? config.themes : [themeArg]
  const screens = onlyScreen ? config.screens.filter((s) => s.name === onlyScreen) : config.screens

  if (screens.length === 0) {
    console.error(`no screen matched --screen ${onlyScreen}`)
    process.exit(1)
  }

  await mkdir(SHOTS, { recursive: true })

  const implWanted = side !== 'mock'
  const implReachable = implWanted ? await fetch(config.baseUrl, { signal: AbortSignal.timeout(3000) }).then(() => true, () => false) : false
  if (implWanted && !implReachable) {
    console.warn(`[shoot] ${config.baseUrl} not reachable — impl side skipped (start the dev server yourself)`)
  }

  // Playwright resolves its bundled chromium by build number, so a machine
  // holding a different build — a devcontainer image that pinned one, a
  // shared cache — has a working browser this script cannot see.
  // RIALTO_CHROMIUM_PATH points it at that binary.
  const chromiumPath = process.env.RIALTO_CHROMIUM_PATH
  const browser = await chromium.launch(
    chromiumPath === undefined || chromiumPath.length === 0 ? {} : { executablePath: chromiumPath }
  )
  const written: string[] = []

  try {
    for (const theme of themes) {
      const context = await browser.newContext({
        viewport: config.viewport,
        deviceScaleFactor: config.deviceScaleFactor,
        colorScheme: theme === 'dark' ? 'dark' : 'light'
      })
      // next-themes reads localStorage.theme, seeded before any script
      // runs. No credential is seeded: the capture runs on the machine the
      // dev server does, and a browser there is exempt from the admin gate.
      await context.addInitScript(
        ({ t }) => {
          try {
            localStorage.setItem('theme', t)
          } catch {
            /* storage unavailable — the page still renders */
          }
        },
        { t: theme }
      )
      const page = await context.newPage()

      for (const screen of screens) {
        if (side !== 'impl') {
          await page.goto(`file://${join(MOCKS, screen.mock)}`, { waitUntil: 'load' })
          await applyTheme(page, theme)
          await settle(page)
          const out = join(SHOTS, `${screen.name}.${theme}.mock.png`)
          await page.screenshot({ path: out })
          written.push(out)
        }

        if (side !== 'mock' && implReachable) {
          if (screen.route === null) {
            console.log(`[shoot] ${screen.name}: mock-only (route: null) — impl skipped`)
          } else {
            await page.goto(`${config.baseUrl}${screen.route}`, { waitUntil: 'networkidle' })
            await applyTheme(page, theme)
            await settle(page)
            const out = join(SHOTS, `${screen.name}.${theme}.impl.png`)
            await page.screenshot({ path: out })
            written.push(out)
          }
        }
      }

      await context.close()
    }
  } finally {
    await browser.close()
  }

  const manifest = {
    capturedAt: new Date().toISOString(),
    viewport: config.viewport,
    deviceScaleFactor: config.deviceScaleFactor,
    files: written.map((f) => f.replace(`${ROOT}/`, ''))
  }
  await writeFile(join(SHOTS, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  for (const f of written) console.log(`[shoot] ${f.replace(`${ROOT}/`, '')}`)
  console.log(`[shoot] ${written.length} file(s) at ${config.viewport.width}×${config.viewport.height} @${config.deviceScaleFactor}x`)
}

await main()
