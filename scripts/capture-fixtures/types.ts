import { z } from 'zod'

const RequestSpecSchema = z.object({
  label: z.string().nonempty(),
  slug: z.string().nonempty(),
  method: z.string().nonempty(),
  url: z.url(),
  body: z.unknown().optional()
})
export type RequestSpec = z.infer<typeof RequestSpecSchema>

const CaptureOptionsSchema = z.object({
  fixturesDir: z.string().nonempty(),
  apiKey: z.string().min(0),
  force: z.boolean()
})
export type CaptureOptions = z.infer<typeof CaptureOptionsSchema>

const ConfigConnectionSchema = z.object({
  configUrl: z.url(),
  apiKey: z.string().min(0)
})
export type ConfigConnection = z.infer<typeof ConfigConnectionSchema>
