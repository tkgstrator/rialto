/**
 * The Chain screen's write-side actions: edit / revert / save, the two
 * single-click surface writes (mode, profile), and the toast plumbing they
 * all share.
 *
 * Kept out of the screen component for the same reason `useChainEditing`
 * is: every one of these is a short "call the API, then toast" shape, and
 * inlining eight of them pushed `RoutingChain`'s cognitive complexity past
 * the Biome limit on its own conditionals.
 */
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { InboundSurfaceWire, RoutingMode, SurfaceId } from '@/lib/api'
import { applyConstraintEdit, type ConstraintEdit } from './derive'
import type { PreferenceApplyResponse, PreferenceProfile } from './types'

export interface ChainActions {
  editing: boolean
  saving: boolean
  quotaSkipValid: boolean
  onQuotaSkipValidity: (valid: boolean) => void
  onEdit: () => void
  onRevert: () => void
  onSave: () => void
  onConstraintEdit: (edit: ConstraintEdit) => void
  onMode: (mode: RoutingMode) => void
  onProfile: (key: string) => void
}

export function useChainActions(
  surface: InboundSurfaceWire | undefined,
  profileKey: string | null,
  setProfile: React.Dispatch<React.SetStateAction<PreferenceProfile>>,
  save: () => Promise<PreferenceApplyResponse>,
  reset: () => void,
  setMode: (surface: SurfaceId, routingMode: RoutingMode) => Promise<void>,
  setSurfaceProfile: (surface: SurfaceId, routingMode: RoutingMode, profileKey: string) => Promise<void>
): ChainActions {
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)
  // Only the Quota skip box can hold text that is not a value yet.
  const [quotaSkipValid, setQuotaSkipValid] = useState(true)

  // Edit mode belongs to the profile it was entered on, rather than being
  // a bare boolean: should the profile change underneath anyway, the
  // freshly loaded rows come up read-only instead of inheriting an edit
  // session that was never theirs.
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const editing = editingKey !== null && editingKey === profileKey

  const notify = useCallback((text: string, ok: boolean) => {
    if (ok) toast.success(text)
    else toast.error(text)
  }, [])

  const fail = useCallback((err: unknown) => notify(err instanceof Error ? err.message : String(err), false), [notify])

  const onEdit = useCallback(() => {
    setQuotaSkipValid(true)
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
        notify(outcome.success ? t('routing.chain.saved') : t('routing.chain.saveFailed'), outcome.success)
        for (const warning of outcome.warnings) toast.warning(warning)
        // Back to reading only once the write took: a refused save keeps
        // the edit on screen, so it can be fixed rather than redone.
        if (outcome.success) setEditingKey(null)
      })
      .catch(fail)
      .finally(() => setSaving(false))
  }, [save, notify, fail, t])

  const onConstraintEdit = useCallback(
    (edit: ConstraintEdit) =>
      setProfile((prev) => ({ ...prev, constraints: applyConstraintEdit(prev.constraints, edit) })),
    [setProfile]
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
    quotaSkipValid,
    onQuotaSkipValidity: setQuotaSkipValid,
    onEdit,
    onRevert,
    onSave,
    onConstraintEdit,
    onMode,
    onProfile
  }
}
