/**
 * Pixel-diff the mock screenshots against the React implementation ones.
 *
 * The comparison runs inside Playwright's own Chromium via canvas
 * getImageData — no pixelmatch / pngjs / sharp dependency, and the same
 * decoder that rendered the pages does the decoding.
 *
 *   bun run .claude/skills/ui-mock-diff/scripts/diff.ts
 *   ... --screen routing --theme dark --threshold 12
 *
 * Reads   mocks/.shots/<screen>.<theme>.{mock,impl}.png
 * Writes  mocks/.shots/<screen>.<theme>.diff.png
 *         mocks/.shots/report.json
 *
 * Exits non-zero when any pair is over --fail-over (default: never, so
 * the agent reads the numbers and decides). Pass --fail-over 2 to use it
 * as a gate.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'

const ROOT = resolve(import.meta.dir, '../../../..')
const MOCKS = join(ROOT, 'mocks')
const SHOTS = join(MOCKS, '.shots')

interface Screen {
  name: string
  route: string | null
}
interface Config {
  themes: string[]
  screens: Screen[]
}

interface Region {
  x: number
  y: number
  w: number
  h: number
  pct: number
}
interface Pair {
  screen: string
  theme: string
  status: 'compared' | 'missing-impl' | 'missing-mock' | 'size-mismatch'
  mockSize?: [number, number]
  implSize?: [number, number]
  mismatchPct?: number
  regions?: Region[]
  diffFile?: string
}

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  return i === -1 ? undefined : process.argv[i + 1]
}

const dataUrl = async (path: string): Promise<string> =>
  `data:image/png;base64,${(await readFile(path)).toString('base64')}`

// Runs in the browser. Kept as one self-contained function because
// page.evaluate serialises it across the boundary.
const compareInPage = ({ a, b, threshold, cell }: { a: string; b: string; threshold: number; cell: number }) =>
  new Promise<{
    width: number
    height: number
    mockSize: [number, number]
    implSize: [number, number]
    mismatch: number
    total: number
    regions: Region[]
    diff: string
  }>((done, fail) => {
    const load = (src: string) =>
      new Promise<HTMLImageElement>((ok, no) => {
        const img = new Image()
        img.onload = () => ok(img)
        img.onerror = () => no(new Error('decode failed'))
        img.src = src
      })

    Promise.all([load(a), load(b)])
      .then(([imgA, imgB]) => {
        const width = Math.min(imgA.width, imgB.width)
        const height = Math.min(imgA.height, imgB.height)

        const read = (img: HTMLImageElement) => {
          const c = document.createElement('canvas')
          c.width = width
          c.height = height
          const ctx = c.getContext('2d', { willReadFrequently: true })!
          ctx.drawImage(img, 0, 0)
          return ctx.getImageData(0, 0, width, height)
        }

        const pa = read(imgA).data
        const pb = read(imgB).data

        const out = document.createElement('canvas')
        out.width = width
        out.height = height
        const octx = out.getContext('2d')!
        const od = octx.createImageData(width, height)

        const cols = Math.ceil(width / cell)
        const rows = Math.ceil(height / cell)
        const grid = new Uint32Array(cols * rows)

        let mismatch = 0
        for (let i = 0; i < pa.length; i += 4) {
          const dr = Math.abs(pa[i] - pb[i])
          const dg = Math.abs(pa[i + 1] - pb[i + 1])
          const db = Math.abs(pa[i + 2] - pb[i + 2])
          const differs = dr > threshold || dg > threshold || db > threshold
          const px = (i / 4) % width
          const py = Math.floor(i / 4 / width)
          if (differs) {
            mismatch++
            grid[Math.floor(py / cell) * cols + Math.floor(px / cell)]++
            // Magenta over the offending pixel.
            od.data[i] = 255
            od.data[i + 1] = 0
            od.data[i + 2] = 200
            od.data[i + 3] = 255
          } else {
            // Matching pixels stay as a faded greyscale ghost so the
            // magenta reads against real layout instead of a void.
            const grey = (pa[i] * 0.299 + pa[i + 1] * 0.587 + pa[i + 2] * 0.114) * 0.35 + 165
            od.data[i] = grey
            od.data[i + 1] = grey
            od.data[i + 2] = grey
            od.data[i + 3] = 255
          }
        }
        octx.putImageData(od, 0, 0)

        // Report the worst cells so the agent gets "the header band and
        // the third table row differ", not just a percentage.
        const cellArea = cell * cell
        const regions: Region[] = []
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const n = grid[r * cols + c]
            if (n === 0) continue
            const pct = (n / cellArea) * 100
            if (pct >= 2) regions.push({ x: c * cell, y: r * cell, w: cell, h: cell, pct: Math.round(pct * 10) / 10 })
          }
        }
        regions.sort((x, y) => y.pct - x.pct)

        done({
          width,
          height,
          mockSize: [imgA.width, imgA.height],
          implSize: [imgB.width, imgB.height],
          mismatch,
          total: width * height,
          regions: regions.slice(0, 12),
          diff: out.toDataURL('image/png')
        })
      })
      .catch((err) => fail(err))
  })

const main = async (): Promise<void> => {
  const config: Config = JSON.parse(await readFile(join(MOCKS, 'mocks.json'), 'utf8'))
  const onlyScreen = arg('--screen')
  const themeArg = arg('--theme') ?? 'both'
  const themes = themeArg === 'both' ? config.themes : [themeArg]
  const threshold = Number(arg('--threshold') ?? 10)
  const failOver = arg('--fail-over') === undefined ? null : Number(arg('--fail-over'))
  // Grid cell in device pixels. 64 @2x ≈ a 32 CSS-px block — small enough
  // to localise a shifted row, large enough that the list stays readable.
  const cell = Number(arg('--cell') ?? 64)

  const screens = onlyScreen ? config.screens.filter((s) => s.name === onlyScreen) : config.screens
  // Same escape hatch shoot.ts has: playwright resolves its bundled chromium
  // by build number, so a machine holding a different build cannot launch it.
  // Only shoot.ts read this, which left the pipeline able to capture both
  // sides and then fail on the step that compares them.
  const chromiumPath = process.env.RIALTO_CHROMIUM_PATH
  const browser = await chromium.launch(
    chromiumPath === undefined || chromiumPath.length === 0 ? {} : { executablePath: chromiumPath }
  )
  const page = await browser.newPage()
  const pairs: Pair[] = []

  try {
    for (const screen of screens) {
      for (const theme of themes) {
        const mockPath = join(SHOTS, `${screen.name}.${theme}.mock.png`)
        const implPath = join(SHOTS, `${screen.name}.${theme}.impl.png`)
        if (!existsSync(mockPath)) {
          pairs.push({ screen: screen.name, theme, status: 'missing-mock' })
          continue
        }
        if (!existsSync(implPath)) {
          pairs.push({ screen: screen.name, theme, status: 'missing-impl' })
          continue
        }

        const [a, b] = await Promise.all([dataUrl(mockPath), dataUrl(implPath)])
        const result = await page.evaluate(compareInPage, { a, b, threshold, cell })

        const diffFile = join(SHOTS, `${screen.name}.${theme}.diff.png`)
        await writeFile(diffFile, Buffer.from(result.diff.split(',')[1], 'base64'))

        const sizeMismatch =
          result.mockSize[0] !== result.implSize[0] || result.mockSize[1] !== result.implSize[1]
        pairs.push({
          screen: screen.name,
          theme,
          status: sizeMismatch ? 'size-mismatch' : 'compared',
          mockSize: result.mockSize,
          implSize: result.implSize,
          mismatchPct: Math.round((result.mismatch / result.total) * 10000) / 100,
          regions: result.regions,
          diffFile: diffFile.replace(`${ROOT}/`, '')
        })
      }
    }
  } finally {
    await browser.close()
  }

  await writeFile(
    join(SHOTS, 'report.json'),
    `${JSON.stringify({ comparedAt: new Date().toISOString(), threshold, cell, pairs }, null, 2)}\n`,
    'utf8'
  )

  for (const p of pairs) {
    if (p.status === 'missing-impl') {
      console.log(`  ${p.screen}/${p.theme}: no impl screenshot — mock-only for now`)
      continue
    }
    if (p.status === 'missing-mock') {
      console.log(`  ${p.screen}/${p.theme}: no mock screenshot`)
      continue
    }
    const size = p.status === 'size-mismatch' ? `  SIZE ${p.mockSize?.join('×')} vs ${p.implSize?.join('×')}` : ''
    const worst = (p.regions ?? []).slice(0, 3).map((r) => `(${r.x},${r.y}) ${r.pct}%`).join(' ')
    console.log(`  ${p.screen}/${p.theme}: ${p.mismatchPct}% differ${size}${worst ? `  worst: ${worst}` : ''}`)
  }
  console.log(`\n  report: mocks/.shots/report.json`)

  if (failOver !== null) {
    const over = pairs.filter((p) => (p.mismatchPct ?? 0) > failOver)
    if (over.length > 0) {
      console.error(`\n  ${over.length} pair(s) over ${failOver}%`)
      process.exit(1)
    }
  }
}

await main()
