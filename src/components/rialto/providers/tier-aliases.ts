/**
 * Pure derivations behind a provider page's tier strip.
 *
 * Routing names a provider and a tier, never a model. A tier some of the
 * provider's models name follows the newest of those that is switched on
 * (`src/shared/tier-resolution.ts`, the rule the server routes by), so the
 * model switches are the whole control there; a refresh lands a new model
 * switched off, and switching it on is what moves the tier. Only a tier no
 * model names — Codex's `gpt-*`, an OpenAI key — takes an alias, picked on
 * this page and staged until Save.
 *
 * Kept out of the components for the same reason `derive.ts` is: what
 * Save would write, and what the strip shows, can be pinned without a
 * browser.
 */
import { newerOffOf, resolveTier } from '@/shared/tier-resolution'
import { disabledModelsOf } from './derive'
import type { Provider, Tier, TierAliasWire } from './types'

/** Strip order, most capable first — the order Routing lists tiers in. */
export const TIERS: readonly Tier[] = ['fable', 'opus', 'sonnet', 'haiku']

/** Tier → the model its manual alias names. An unset tier is absent, not null. */
export type AliasMap = Partial<Record<Tier, string>>

/** Aliases picked while editing; null unsets one. */
export type AliasPicks = Partial<Record<Tier, string | null>>

export interface AliasChange {
  tier: Tier
  /** The model to point the tier at; null unsets it. */
  model: string | null
}

/** One provider's rows out of the install-wide list. */
export const aliasRowsOf = (rows: readonly TierAliasWire[], provider: string): TierAliasWire[] =>
  rows.filter((row) => row.provider === provider)

/**
 * The stored aliases of one provider's manual tiers. A derived tier's
 * model is not an alias — nothing Save writes can move it — so it is left
 * out, and a pick is only ever compared with a manual alias.
 */
export function aliasMapOf(rows: readonly TierAliasWire[]): AliasMap {
  return Object.fromEntries(
    rows.flatMap(
      (row): Array<[Tier, string]> => (row.mode === 'manual' && row.model !== null ? [[row.tier, row.model]] : [])
    )
  )
}

const storedOf = (stored: AliasMap, tier: Tier): string | null => {
  const model = stored[tier]
  return model === undefined ? null : model
}

/**
 * The picks that differ from what is stored — the writes Save makes.
 *
 * A pick made and then undone by hand drops out here, so it writes
 * nothing; and because an alias write also switches its model on, that
 * matters beyond a wasted request.
 */
export function aliasChanges(stored: AliasMap, picks: AliasPicks): AliasChange[] {
  return TIERS.flatMap((tier) => {
    const picked = picks[tier]
    if (picked === undefined || picked === storedOf(stored, tier)) return []
    return [{ tier, model: picked }]
  })
}

/** The aliases as Save would leave them, which is what the page shows while editing. */
export function applyAliasPicks(stored: AliasMap, picks: AliasPicks): AliasMap {
  const next: AliasMap = { ...stored }
  for (const { tier, model } of aliasChanges(stored, picks)) {
    if (model === null) delete next[tier]
    else next[tier] = model
  }
  return next
}

/** One tier as the page shows it. */
export interface TierView {
  tier: Tier
  /** derived: follows the newest switched-on model its name says. manual: the alias. */
  mode: 'derived' | 'manual'
  /** The model the tier reaches, switched on or not; null only on an unset manual tier. */
  model: string | null
  /** Whether that model is switched on. */
  enabled: boolean
  /** A derived tier's models, newest first; empty on a manual tier. */
  named: string[]
  /** Named models newer than `model` and switched off: switching one on moves the tier. */
  newer: string[]
}

/**
 * Every tier of `provider`, resolved by the rule the server routes by.
 *
 * Run on the provider as Save would leave it (the draft applied), so while
 * editing the strip already shows where a switch moves each tier. Every
 * model row counts, as on the server — a deprecated one the table hides
 * can still be the newest switched-on model.
 */
export function tierViewsOf(provider: Provider, manual: AliasMap): TierView[] {
  const off = new Set(disabledModelsOf(provider))
  const models = provider.models.map((name) => ({ name, enabled: !off.has(name) }))
  return TIERS.map((tier) => {
    const aliased = manual[tier]
    const alias = aliased === undefined ? null : { name: aliased, enabled: !off.has(aliased) }
    const resolution = resolveTier(models, tier, alias)
    const model = resolution.model
    return {
      tier,
      mode: resolution.mode,
      model: model === null ? null : model.name,
      enabled: model === null ? false : model.enabled,
      named: resolution.mode === 'derived' ? resolution.named.map((m) => m.name) : [],
      newer: newerOffOf(resolution).map((m) => m.name)
    }
  })
}

export interface AliasOptions {
  /** What the alias names as stored, whatever the edit has staged. */
  current: string | null
  /**
   * Every other listed model on the provider. A manual tier is one no
   * model names, so there is no candidate to put first — the alias is
   * exactly how an operator says what "sonnet" means there.
   */
  others: string[]
}

/**
 * What a manual tier's picker offers.
 *
 * Built from what is stored rather than from the staged pick, so the list
 * holds still while the operator moves between entries in it — and the
 * stored model stays in it, which is how a pick is taken back.
 */
export function aliasOptions(current: string | null, listed: readonly string[]): AliasOptions {
  return { current, others: listed.filter((model) => model !== current) }
}
