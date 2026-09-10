/**
 * Public entry point for subscription usage polling + headroom checks.
 *
 * Implementation lives in ./usage-service/*:
 *   - cache: shared in-memory per-account cache + test seams
 *   - fetch: live upstream polling and TTL-cached snapshot reads
 *   - headroom: cache-only single-window (5h / primary) headroom
 *   - window-headroom: window-selectable (weekly-aware) drain targets
 */

export type {
  ClaudeUsage,
  ClaudeUsageWindow,
  CodexUsage,
  CodexUsageWindow,
  GetUsageInput,
  GetUsageOutput,
  UsageResponse
} from '../schemas/api/usage'
export {
  __clearUsageCachesForTest,
  __seedClaudeCacheForTest,
  __seedCodexCacheForTest
} from './usage-service/cache'
export {
  fetchUsageSnapshot,
  fetchUsageSnapshotWithAccountIds,
  getUsage
} from './usage-service/fetch'
export { getKindHeadroom, headroomFrom, PROACTIVE_THRESHOLD_PCT, type UsageWindow } from './usage-service/headroom'
export {
  type ClaudeWindowKey,
  type CodexWindowKey,
  type DrainTarget,
  drainTarget,
  getAccountHeadroom,
  getAccountWindow,
  getKindWindowHeadroom,
  type WindowUsage
} from './usage-service/window-headroom'
