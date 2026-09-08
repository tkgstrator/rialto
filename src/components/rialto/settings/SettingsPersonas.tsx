/**
 * Settings → Personas.
 *
 * Absorbs `Personas` + `PersonaView` + `PersonaEdit`. Those were three
 * routes for one object: a list that could only select, a read-only page
 * that could only link onward, and an editor you had to navigate to. Here
 * the list selects and the pane edits, so renaming a persona and making
 * it active are one save instead of two page transitions.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useConfig } from '@/components/ConfigProvider'
import { RButton } from '@/components/rialto/primitives'
import { api, type InboundSurfaceWire } from '@/lib/api'
import { copyName, type PersonaDraft, toDrafts } from '@/lib/rialto/settings-content/persona'
import type { Config } from '@/types'
import { PersonaDetail } from './personas/PersonaDetail'
import { PersonaList } from './personas/PersonaList'
import { SettingsLayout } from './SettingsLayout'
import { useUnsavedGuard } from './use-unsaved-guard'

const activeFromConfig = (config: Config): string | null =>
  typeof config.Router.persona === 'string' && config.Router.persona !== '' ? config.Router.persona : null

function PersonasEditor({ config }: { config: Config }) {
  const { t } = useTranslation()
  const { reloadConfig } = useConfig()
  const persisted = useMemo(() => toDrafts(config.Personas), [config.Personas])
  const persistedActive = activeFromConfig(config)

  const [drafts, setDrafts] = useState<PersonaDraft[]>(persisted)
  const [activeId, setActiveId] = useState<string | null>(persistedActive)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [surfaces, setSurfaces] = useState<InboundSurfaceWire[]>([])
  const [saving, setSaving] = useState(false)

  // Re-sync whenever the provider hands over a new config — a fresh
  // mount, a save, or an edit made elsewhere. Doubles as Discard.
  const reset = useCallback(() => {
    setDrafts(persisted)
    setActiveId(persistedActive)
  }, [persisted, persistedActive])

  useEffect(reset, [reset])

  useEffect(() => {
    api
      .getInboundSurfaces()
      .then((res) => setSurfaces(res.surfaces))
      .catch(() => {
        // The scope bar is descriptive; a failed probe leaves it empty
        // rather than blocking the editor.
      })
  }, [])

  const selected = drafts.find((d) => d.id === selectedId)
  const current = selected === undefined ? drafts[0] : selected

  const patchCurrent = useCallback(
    (patch: Partial<PersonaDraft>) => {
      if (current === undefined) return
      setDrafts((prev) => prev.map((d) => (d.id === current.id ? { ...d, ...patch } : d)))
    },
    [current]
  )

  const create = useCallback(() => {
    const draft: PersonaDraft = { id: crypto.randomUUID(), name: t('settings.personas.newName'), prompt: '' }
    setDrafts((prev) => [...prev, draft])
    setSelectedId(draft.id)
  }, [t])

  const duplicate = useCallback(() => {
    if (current === undefined) return
    const draft: PersonaDraft = {
      id: crypto.randomUUID(),
      name: copyName(
        current.name,
        drafts.map((d) => d.name)
      ),
      prompt: current.prompt
    }
    setDrafts((prev) => [...prev, draft])
    setSelectedId(draft.id)
  }, [current, drafts])

  const remove = useCallback(() => {
    if (current === undefined) return
    setDrafts((prev) => prev.filter((d) => d.id !== current.id))
    setActiveId((prev) => (prev === current.id ? null : prev))
    setSelectedId(null)
  }, [current])

  const save = useCallback(async () => {
    setSaving(true)
    try {
      // `persona` goes out as an explicit null when nothing is active:
      // the server tells "clear it" from "this save didn't touch it" by
      // whether the key is present, and JSON.stringify drops undefined.
      await api.updateConfig({ ...config, Personas: drafts, Router: { ...config.Router, persona: activeId } })
      await reloadConfig()
      toast.success(t('settings.personas.saved'))
    } catch (err) {
      toast.error(t('settings.common.saveFailed', { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setSaving(false)
    }
  }, [config, drafts, activeId, reloadConfig, t])

  const dirty = activeId !== persistedActive || JSON.stringify(drafts) !== JSON.stringify(persisted)
  useUnsavedGuard(dirty)
  const activeCount = activeId === null ? 0 : 1

  return (
    <SettingsLayout
      active='personas'
      subtitle={t('settings.personas.subtitle', {
        count: drafts.length,
        active: t(activeCount === 0 ? 'settings.personas.noneActive' : 'settings.personas.oneActive')
      })}
      // The body's first element is the library column, which carries its
      // own heading and count — a section heading above it would push the
      // three panes out of alignment with each other.
      showHeading={false}
      actions={
        <>
          <RButton variant='ghost' onClick={reset} disabled={!dirty || saving}>
            {t('common.discard')}
          </RButton>
          <RButton variant='primary' icon='ri-check-line' onClick={save} disabled={!dirty || saving}>
            {t('common.save')}
          </RButton>
        </>
      }
    >
      <div className='grid h-full grid-cols-[17rem_1fr]'>
        <PersonaList
          personas={drafts}
          selectedId={current === undefined ? null : current.id}
          activeId={activeId}
          onSelect={setSelectedId}
          onCreate={create}
        />
        {current === undefined ? (
          <div className='min-w-0 px-6 py-6 text-xs text-muted-foreground'>{t('settings.personas.empty')}</div>
        ) : (
          <PersonaDetail
            persona={current}
            active={current.id === activeId}
            surfaces={surfaces}
            onRename={(name) => patchCurrent({ name })}
            onEditPrompt={(prompt) => patchCurrent({ prompt })}
            onToggleActive={() => setActiveId((prev) => (prev === current.id ? null : current.id))}
            onDuplicate={duplicate}
            onDelete={remove}
          />
        )}
      </div>
    </SettingsLayout>
  )
}

export function SettingsPersonas() {
  const { t } = useTranslation()
  const { config } = useConfig()
  if (config === null) {
    return (
      <SettingsLayout active='personas' showHeading={false}>
        <div className='px-6 py-6 text-xs text-muted-foreground'>{t('common.loading')}</div>
      </SettingsLayout>
    )
  }
  return <PersonasEditor config={config} />
}
