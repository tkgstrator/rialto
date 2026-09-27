import { spawn } from 'node:child_process'
import { OpenAPIHono } from '@hono/zod-openapi'
import { ScrapePricesVendorSchema } from '../../../schemas/api/price'
import { validationErrorHook } from '../../zod-response'
export const scrapePricesRoute = new OpenAPIHono({ defaultHook: validationErrorHook })

// Spawn the per-vendor scrape script and pipe its output back. Path
// params don't compose well through @hono/zod-openapi for this case,
// so we register a plain handler. The OpenAPI spec omits this route.
const SCRAPER_SCRIPTS: Record<string, string> = {
  openai: 'scripts/scrape-openai-prices.ts',
  anthropic: 'scripts/scrape-anthropic-prices.ts',
  google: 'scripts/scrape-gemini-pricing.ts',
  all: 'scripts/scrape-all-prices.ts'
}

scrapePricesRoute.post('/api/scrape-prices/:vendor', async (c) => {
  const raw = c.req.param('vendor')
  const vendor = ScrapePricesVendorSchema.parse(raw)
  const script = SCRAPER_SCRIPTS[vendor]
  // The dev server is launched from the repo root by package.json's
  // `bun dev` script; production CLI mode currently can't reach the
  // scrape scripts anyway, so this path is dev-only.
  const cwd = process.cwd()
  const dry = c.req.query('dry') === '1' || c.req.query('dry') === 'true'
  const args = ['run', script, ...(dry ? ['--dry'] : [])]
  try {
    const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('bun', args, { cwd })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      child.on('error', (err) => reject(err))
      child.on('exit', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }))
    })
    return c.json(
      {
        success: result.exitCode === 0,
        vendor,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr
      },
      200
    )
  } catch (err) {
    return c.json(
      {
        success: false as const,
        vendor,
        exitCode: -1,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err)
      },
      200
    )
  }
})
