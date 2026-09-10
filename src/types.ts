// Type-only shim that re-exports the domain types the UI reads most.
// New code should import the owning layer directly (`@/schemas/domain`,
// `@/schemas/api`); this file exists so existing `from '@/types'`
// imports keep working without churn.
export { type Config, ConfigSchema } from '@/schemas/api/config'
export {
  type Persona,
  type Provider,
  type ProviderAuthMode,
  ProviderAuthModeSchema,
  ProviderSchema,
  type ProviderTransformer,
  ProviderTransformerSchema,
  type StatusLineConfig,
  StatusLineConfigSchema,
  type StatusLineModuleConfig,
  StatusLineModuleConfigSchema,
  type StatusLineThemeConfig,
  StatusLineThemeConfigSchema
} from '@/schemas/domain'
export { type AccessLevel, AccessLevelSchema } from '@/schemas/primitives/common'
// Schemas that were value-exported from this file before the move.
