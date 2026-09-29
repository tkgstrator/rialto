/**
 * The capability readings a model row shows beside its name on a wide
 * window: the effort levels its own list reported and the ways thinking
 * can be switched off on it. Pure, so the summary rules are pinned by
 * tests rather than by eye.
 */

import {
  type SupportedEffort,
  SupportedEffortSchema,
  type ThinkingEffortKey,
  type ThinkingOff
} from '@/schemas/domain/model-capability'
import type { ReasoningEffort } from './types'

/**
 * The recorded levels, lowest first.
 *
 * Read off the schema's ladder rather than sorted, so the order does not
 * depend on how the vendor listed them, and a "≤ high" reading below can
 * count along it.
 */
export const effortLadder = (efforts: readonly ReasoningEffort[]): SupportedEffort[] =>
  SupportedEffortSchema.options.filter((level) => efforts.some((effort) => effort === level))

/** The wire spelling, which is what a caller sets and what the logs say. */
export type ThinkingOffSetting = 'disabled' | 'between_tools'

/**
 * One way of switching thinking off, where the model takes it.
 *
 * - `always`: at every recorded effort and with none sent.
 * - `upTo`: at every recorded effort up to `effort`. The shape the probe
 *   finds when high effort is the cut-off (Opus 5 `disabled`, Sonnet 5.5
 *   `between_tools`; docs/architecture/model-capabilities.md).
 * - `at`: any other set, listed as the probe keys it held at.
 */
export type ThinkingOffReading =
  | { setting: ThinkingOffSetting; when: 'always' }
  | { setting: ThinkingOffSetting; when: 'upTo'; effort: SupportedEffort }
  | { setting: ThinkingOffSetting; when: 'at'; keys: ThinkingEffortKey[] }

const readSetting = (
  setting: ThinkingOffSetting,
  accepted: readonly ThinkingEffortKey[],
  ladder: readonly SupportedEffort[]
): ThinkingOffReading[] => {
  if (accepted.length === 0) return []
  const named = ladder.filter((level) => accepted.includes(level))
  const withDefault = accepted.includes('default')
  if (named.length === ladder.length && withDefault) return [{ setting, when: 'always' }]
  // `named` keeps the ladder's order, so it is a prefix of the ladder
  // exactly when its top sits at its own length.
  const top = named.at(-1)
  if (top !== undefined && ladder.indexOf(top) === named.length - 1) return [{ setting, when: 'upTo', effort: top }]
  return [{ setting, when: 'at', keys: withDefault ? ['default', ...named] : named }]
}

/**
 * The ways thinking can be switched off on this model, in the order
 * `pipeline/thinking-off.ts` tries them. Empty means neither is taken
 * anywhere: thinking cannot be switched off, and a caller's `disabled`
 * is dropped.
 *
 * `efforts` is the model's recorded levels, the ones the probe was sent at.
 */
export const thinkingOffReadings = (
  thinkingOff: ThinkingOff,
  efforts: readonly ReasoningEffort[] | null
): ThinkingOffReading[] => {
  const ladder = effortLadder(efforts === null ? [] : efforts)
  return [
    ...readSetting('disabled', thinkingOff.disabled, ladder),
    ...readSetting('between_tools', thinkingOff.betweenTools, ladder)
  ]
}
