/**
 * The status-line theme, as it is stored on disk under the envelope's
 * StatusLine key. Domain because it is config the app persists, not a
 * shape any route defines.
 */

import { z } from '@hono/zod-openapi'

export const StatusLineModuleConfigSchema = z.object({
  type: z.string().nonempty(),
  icon: z.string().nonempty().optional(),
  text: z.string().nonempty(),
  color: z.string().nonempty().optional(),
  background: z.string().nonempty().optional(),
  scriptPath: z.string().nonempty().optional(),
  // Model-only: the `{{model}}` token has always been the shorter
  // `provider,model` pair's tail — stripped is the default every module
  // was born with before this field existed, so "keep it" is the flag,
  // false by default, rather than a "strip it" flag defaulting true.
  keepProvider: z.boolean().default(false),
  // Printed after the module's own text, unstyled — a `|` or `·` an
  // operator wants between segments without reaching for the Format field.
  separator: z.string().nonempty().optional()
})
export type StatusLineModuleConfig = z.infer<typeof StatusLineModuleConfigSchema>

export const StatusLineThemeConfigSchema = z.object({
  modules: z.array(StatusLineModuleConfigSchema)
})
export type StatusLineThemeConfig = z.infer<typeof StatusLineThemeConfigSchema>

export const StatusLineConfigSchema = z.object({
  enabled: z.boolean(),
  currentStyle: z.string().nonempty(),
  default: StatusLineThemeConfigSchema,
  powerline: StatusLineThemeConfigSchema,
  fontFamily: z.string().nonempty().optional()
})
export type StatusLineConfig = z.infer<typeof StatusLineConfigSchema>
