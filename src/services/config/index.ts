/**
 * Public API surface of the DB-backed config module.
 *
 * `composeUiConfig` joins the on-disk envelope with the DB-resident
 * Providers table into the `AppConfig` shape consumed by the API / UI;
 * `applyUiConfig` diffs an incoming UI payload against DB state in a
 * single transaction.
 */

export { apiStyleForVendor, modelApiStyleOverride } from './api-style'
export { type ApplyResult, applyUiConfig } from './apply'
export { composeUiConfig, loadFullConfig } from './compose'
export {
  deleteProviderByName,
  getProviders,
  setModelEnabled,
  setModelManualTier,
  setModelReasoningEffort,
  upsertProvider
} from './crud'
export { getEnabledModels } from './enabled-models'
export { ensurePreferenceProfile, ensureSeedProviders } from './seed'
