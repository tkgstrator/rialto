/**
 * Editing operations on the scenario routes' draft.
 *
 * Kept out of the table: each is one pure step in `derive.ts` applied to
 * the draft, and inlining them next to the markup is what turned the old
 * preference editor into an 800-line file.
 */
import { useMemo } from 'react'
import { addCombination, changeCombination, moveCombination, removeCombination, toggleCombination } from './derive'
import type { CellAddress, ModelTier, ScenarioDraft } from './types'

export interface ScenarioEditing {
  onAdd: (at: CellAddress, provider: string, tier: ModelTier) => void
  onChange: (at: CellAddress, index: number, provider: string, tier: ModelTier) => void
  onRemove: (at: CellAddress, index: number) => void
  onMove: (at: CellAddress, from: number, to: number) => void
  onToggle: (at: CellAddress, index: number, enabled: boolean) => void
}

export function useScenarioEditing(setDraft: React.Dispatch<React.SetStateAction<ScenarioDraft>>): ScenarioEditing {
  return useMemo<ScenarioEditing>(
    () => ({
      onAdd: (at, provider, tier) => setDraft((prev) => addCombination(prev, at, provider, tier)),
      onChange: (at, index, provider, tier) => setDraft((prev) => changeCombination(prev, at, index, provider, tier)),
      onRemove: (at, index) => setDraft((prev) => removeCombination(prev, at, index)),
      onMove: (at, from, to) => setDraft((prev) => moveCombination(prev, at, from, to)),
      onToggle: (at, index, enabled) => setDraft((prev) => toggleCombination(prev, at, index, enabled))
    }),
    [setDraft]
  )
}
