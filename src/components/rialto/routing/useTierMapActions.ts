/**
 * The Routing screen's write-side actions: edit / revert / save, the two
 * single-click surface writes (mode, profile), and the toast plumbing they
 * all share.
 *
 * Kept out of the screen component for the same reason `useTierMapEditing`
 * is: every one of these is a short "call the API, then toast" shape, and
 * inlining them pushed the screen's cognitive complexity past the Biome
 * limit on its own conditionals.
 */
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { InboundSurfaceWire, RoutingMode, SurfaceId, TierProfileSaveOutcome } from '@/lib/api'
import { applyConstraintEdit, type ConstraintEdit } from './derive'
import type { TierDraft } from './types'

/** The constraint cells that take typed text, and so can hold a value that is not one yet. */
export type TypedConstraint = 'quotaSkipPct' | 'errorRateSkipPct' | 'minHealthSamples'

export interface TierMapWriteActions {
  editing: boolean
  saving: boolean
  /** Every typed cell holds a value the profile can store. */
  constraintsValid: boolean
  onConstraintValidity: (field: TypedConstraint, valid: boolean) => void
  onEdit: () => void
  onRevert: () => void
  onSave: () => void
  onConstraintEdit: (edit: ConstraintEdit) => void
  onMode: (mode: RoutingMode) => void
  onProfile: (key: string) => void
}

export function useTierMapActions(
  surface: InboundSurfaceWire | undefined,
  profileKey: string | null,
  setDraft: React.Dispatch<React.SetStateAction<TierDraft>>,
  save: () => Promise<TierProfileSaveOutcome>,
  reset: () => void,
  onSaved: () => void,
  setMode: (surface: SurfaceId, routingMode: RoutingMode) => Promise<void>,
  setSurfaceProfile: (surface: SurfaceId, routingMode: RoutingMode, profileKey: string) => Promise<void>
): TierMapWriteActions {
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)
  // The typed cells currently holding text that is not a value. A set
  // rather than one flag: fixing one cell must not clear another's error.
  const [invalid, setInvalid] = useState<ReadonlySet<TypedConstraint>>(new Set())

  // Edit mode belongs to the profile it was entered on, rather than being
  // a bare boolean: should the profile change underneath anyway, the
  // freshly loaded map comes up read-only instead of inheriting an edit
  // session that was never its own.
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const editing = editingKey !== null && editingKey === profileKey

  const notify = useCallback((text: string, ok: boolean) => {
    if (ok) toast.success(text)
    else toast.error(text)
  }, [])

  const fail = useCallback((err: unknown) => notify(err instanceof Error ? err.message : String(err), false), [notify])

  const onConstraintValidity = useCallback((field: TypedConstraint, valid: boolean) => {
    setInvalid((prev) => {
      if (valid === !prev.has(field)) return prev
      const next = new Set(prev)
      if (valid) next.delete(field)
      else next.add(field)
      return next
    })
  }, [])

  const onEdit = useCallback(() => {
    setInvalid(new Set())
    setEditingKey(profileKey)
  }, [profileKey])

  const onRevert = useCallback(() => {
    reset()
    setEditingKey(null)
  }, [reset])

  const onSave = useCallback(() => {
    setSaving(true)
    save()
      .then((outcome) => {
        notify(outcome.success ? t('routing.tiers.saved') : t('routing.tiers.saveFailed'), outcome.success)
        // Warnings name what the server dropped (an unknown provider, a
        // duplicate) or kept but cannot use yet (an unset alias). They
        // are not failures, so each gets its own toast rather than being
        // folded into the success one.
        for (const warning of outcome.warnings) toast.warning(warning)
        // Back to reading only once the write took: a refused save keeps
        // the edit on screen, so it can be fixed rather than redone.
        if (outcome.success) {
          setEditingKey(null)
          onSaved()
        }
      })
      .catch(fail)
      .finally(() => setSaving(false))
  }, [save, notify, fail, onSaved, t])

  const onConstraintEdit = useCallback(
    (edit: ConstraintEdit) =>
      setDraft((prev) => ({ ...prev, constraints: applyConstraintEdit(prev.constraints, edit) })),
    [setDraft]
  )

  // The mode, the profile and the reset apply on click — there is no
  // Save for them, in the design or here, because each is a single
  // choice rather than an edit in progress. That only reads as
  // deliberate if the write is acknowledged; silence is
  // indistinguishable from a dropped click, which is what makes people
  // go looking for a Save button.
  const onMode = useCallback(
    (mode: RoutingMode) => {
      if (surface === undefined) return
      setMode(surface.id, mode)
        .then(() =>
          notify(
            t('routing.chain.modeChanged', {
              path: surface.path,
              mode: t(mode === 'routed' ? 'routing.common.modeRouted' : 'routing.common.modePassthrough')
            }),
            true
          )
        )
        .catch(fail)
    },
    [surface, setMode, notify, fail, t]
  )

  const onProfile = useCallback(
    (key: string) => {
      if (surface === undefined) return
      setSurfaceProfile(surface.id, surface.routingMode, key)
        .then(() => notify(t('routing.chain.profileChanged', { path: surface.path, profile: key }), true))
        .catch(fail)
    },
    [surface, setSurfaceProfile, notify, fail, t]
  )

  return {
    editing,
    saving,
    constraintsValid: invalid.size === 0,
    onConstraintValidity,
    onEdit,
    onRevert,
    onSave,
    onConstraintEdit,
    onMode,
    onProfile
  }
}
