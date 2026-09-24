/**
 * Pure derivations behind a provider page's tier-alias strip.
 *
 * Routing names a provider and a tier, never a model: the alias is what
 * says which model "claude-code · sonnet" is today, and it is the one
 * pointer a new model release moves. It never moves by itself — a
 * refresh only lists a newer model as a candidate, and pointing the
 * alias at it (promoting it) is an edit this page stages until Save.
 *
 * Kept out of the components for the same reason `derive.ts` is: what
 * Save would write, and what the strip offers, can be pinned without a
 * browser.
 */
import type { Tier, TierAliasWire } from './types'

/** Strip order, most capable first — the order Routing lists tiers in. */
export const TIERS: readonly Tier[] = ['fable', 'opus', 'sonnet', 'haiku']

/** Tier → the model its alias names. An unset tier is absent, not null. */
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

/** The stored aliases of one provider's rows. */
export function aliasMapOf(rows: readonly TierAliasWire[]): AliasMap {
  return Object.fromEntries(
    rows.flatMap((row): Array<[Tier, string]> => (row.model === null ? [] : [[row.tier, row.model]]))
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

/** The tiers `model` is the alias for, in strip order. One model may serve several. */
export const tiersServedBy = (aliases: AliasMap, model: string): Tier[] =>
  TIERS.filter((tier) => aliases[tier] === model)

/** Models some tier lists as a new candidate — found after that alias was last set. */
export const freshModelsOf = (rows: readonly TierAliasWire[]): Set<string> =>
  new Set(rows.flatMap((row) => row.candidates.filter((c) => c.isNew).map((c) => c.model)))

export const newCountOf = (row: TierAliasWire | undefined): number =>
  row === undefined ? 0 : row.candidates.filter((c) => c.isNew).length

export interface AliasOptions {
  /** What the alias names as stored, whatever the edit has staged. */
  current: string | null
  /** Models whose name says this tier, new ones first. */
  candidates: Array<{ model: string; isNew: boolean }>
  /**
   * Every other listed model on the provider. A candidate is only a model
   * whose name says the tier, and Codex or an OpenAI key names no Claude
   * family at all — offering candidates alone would leave those providers
   * with nothing to pick, although the alias is exactly how an operator
   * says what "sonnet" means there.
   */
  others: string[]
}

/**
 * What a tier's picker offers.
 *
 * Built from what is stored rather than from the staged pick, so the list
 * holds still while the operator moves between entries in it — and the
 * stored model stays in it, which is how a pick is taken back.
 */
export function aliasOptions(row: TierAliasWire | undefined, listed: readonly string[]): AliasOptions {
  const current = row === undefined ? null : row.model
  // Stable, so the server's newest-first order holds inside each half.
  const candidates = (row === undefined ? [] : row.candidates)
    .filter((c) => c.model !== current)
    .map((c) => ({ model: c.model, isNew: c.isNew }))
    .sort((a, b) => Number(b.isNew) - Number(a.isNew))
  const taken = new Set([...(current === null ? [] : [current]), ...candidates.map((c) => c.model)])
  return { current, candidates, others: listed.filter((model) => !taken.has(model)) }
}
