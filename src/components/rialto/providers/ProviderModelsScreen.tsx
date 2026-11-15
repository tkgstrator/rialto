/**
 * One index of models across every configured provider.
 *
 * Model switches use the same mutation as the provider page.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { PhoneRow, RButton, Section, Toggle } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { fmtCost } from '@/lib/sessions/format'
import { toggleModel } from './actions'
import { buildModelRows, fmtContext, type ModelRow } from './derive'
import { SwitchReading } from './SwitchReading'
import type { Provider } from './types'
import { type ProvidersData, useProvidersData } from './useProvidersData'
import { type RefreshScope, useRefresh } from './useRefresh'
import { vendorLabel } from './vendor-labels'

interface ModelGroup {
  provider: Provider
  label: string
  rows: ModelRow[]
}

type SaveChange = (group: ModelGroup, write: () => Promise<void>, failure: (message: string) => string) => Promise<void>

function modelGroups(data: ProvidersData): ModelGroup[] {
  return data.providers.map((provider) => {
    const entry = data.catalog.find((vendor) => vendor.name === provider.name)
    return {
      provider,
      label: entry === undefined ? provider.name : vendorLabel(entry.name, entry.displayName),
      rows: buildModelRows(provider, entry)
    }
  })
}

function matchingGroups(groups: ModelGroup[], query: string): ModelGroup[] {
  const term = query.trim().toLocaleLowerCase()
  return groups
    .map((group) => ({
      ...group,
      rows:
        term === '' || group.label.toLocaleLowerCase().includes(term)
          ? group.rows
          : group.rows.filter((row) => row.name.toLocaleLowerCase().includes(term))
    }))
    .filter((group) => group.rows.length > 0)
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const REFRESH_SCOPE: RefreshScope = { accounts: 'none' }

export function ProviderModelsScreen() {
  const { t } = useTranslation()
  const { data, error, reload } = useProvidersData()
  const { pending: refreshPending, refresh } = useRefresh(REFRESH_SCOPE, reload)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(false)
  // One write at a time. Each model upsert starts from the loaded
  // provider; two simultaneous switches on it would each send the old
  // disabled-model list and the last write would undo the first.
  const [pending, setPending] = useState(false)
  const groups = data === null ? [] : modelGroups(data)
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0)
  const enabled = groups.reduce((sum, group) => sum + group.rows.filter((row) => row.enabled).length, 0)
  const matching = matchingGroups(groups, query)

  const save = async (group: ModelGroup, write: () => Promise<void>, failure: (message: string) => string) => {
    if (pending || refreshPending !== null || !editing) return
    setPending(true)
    try {
      await write()
      await reload()
      toast.success(t('providers.detail.saved', { name: group.label }))
    } catch (err) {
      toast.error(failure(messageOf(err)))
    } finally {
      setPending(false)
    }
  }

  return (
    <Screen subtitle={data === null ? undefined : t('providers.models.enabledCount', { enabled, total })}>
      <div className='flex flex-wrap items-center gap-2 px-4 py-4 md:px-6'>
        <label className='sr-only' htmlFor='model-search'>
          {t('providers.models.filterModels')}
        </label>
        <div className='flex min-w-32 max-w-sm flex-1 items-center gap-2 rounded-md border border-border px-3'>
          <i aria-hidden className='ri-search-line text-sm text-muted-foreground' />
          <input
            id='model-search'
            type='search'
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('providers.models.filterModels')}
            className='h-9 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground'
          />
        </div>
        <div className='ml-auto flex items-center gap-1'>
          <RButton
            variant='outline'
            icon={editing ? 'ri-check-line' : 'ri-pencil-line'}
            onClick={() => setEditing((value) => !value)}
            disabled={data === null || pending || refreshPending !== null}
          >
            {t(editing ? 'common.done' : 'common.edit')}
          </RButton>
          <RButton
            variant='outline'
            icon='ri-refresh-line'
            onClick={refresh}
            disabled={pending || refreshPending !== null}
          >
            {t('providers.screen.refresh')}
          </RButton>
        </div>
        {editing ? (
          <p className='w-full text-[12px] text-muted-foreground'>{t('providers.models.autoSaveHint')}</p>
        ) : null}
      </div>
      <ModelsContent
        dataPresent={data !== null}
        error={error}
        groups={matching}
        total={total}
        editing={editing}
        busy={pending || refreshPending !== null}
        onSave={save}
      />
      <div className='h-6' />
    </Screen>
  )
}

function ModelsContent({
  dataPresent,
  error,
  groups,
  total,
  editing,
  busy,
  onSave
}: {
  dataPresent: boolean
  error: string | null
  groups: ModelGroup[]
  total: number
  editing: boolean
  busy: boolean
  onSave: SaveChange
}) {
  const { t } = useTranslation()
  if (error !== null) return <p className='px-4 text-xs text-destructive md:px-6'>{error}</p>
  if (!dataPresent) return <p className='px-4 text-xs text-muted-foreground md:px-6'>{t('common.loading')}</p>
  if (groups.length === 0) {
    return (
      <p className='px-4 text-xs text-muted-foreground md:px-6'>
        {total === 0 ? t('providers.models.noneAvailable') : t('shell.searchEmpty')}
      </p>
    )
  }
  return groups.map((group) => (
    <ModelSection
      key={group.provider.name}
      group={group}
      editing={editing}
      busy={busy}
      onToggle={(model, next) =>
        onSave(
          group,
          () => toggleModel(group.provider, model, next),
          (message) => t('providers.detail.saveFailedProvider', { message })
        )
      }
    />
  ))
}

function ModelSection({
  group,
  editing,
  busy,
  onToggle
}: {
  group: ModelGroup
  editing: boolean
  busy: boolean
  onToggle: (model: string, next: boolean) => void
}) {
  const { t } = useTranslation()
  const href = `/providers/${encodeURIComponent(group.provider.name)}`
  return (
    <Section
      title={group.label}
      meta={t('providers.models.enabledCount', {
        enabled: group.rows.filter((row) => row.enabled).length,
        total: group.rows.length
      })}
    >
      <div className='pb-2 md:hidden'>
        {group.rows.map((row) => (
          <PhoneRow
            key={row.name}
            primary={
              <Link to={href} className='block truncate font-mono hover:underline'>
                {row.name}
              </Link>
            }
            trailing={<ModelSwitch row={row} editing={editing} busy={busy} onToggle={onToggle} />}
            secondary={<span className='font-mono'>{fmtContext(row.contextWindow)}</span>}
          />
        ))}
      </div>
      <div className='hidden pb-4 md:block'>
        <div className='grid grid-cols-[minmax(0,1fr)_5rem_6rem_7rem_7rem] gap-4 px-6 pb-2 text-[11px] uppercase tracking-wider text-muted-foreground'>
          <span>{t('providers.models.colModel')}</span>
          <span>{t('providers.models.colOn')}</span>
          <span>{t('providers.models.colContext')}</span>
          <span className='text-right'>{t('providers.models.colIn')}</span>
          <span className='text-right'>{t('providers.models.colOut')}</span>
        </div>
        {group.rows.map((row) => (
          <div
            key={row.name}
            className='grid grid-cols-[minmax(0,1fr)_5rem_6rem_7rem_7rem] items-center gap-4 border-t border-border/60 px-6 py-3 text-xs hover:bg-muted/50'
          >
            <Link to={href} className='min-w-0 truncate font-mono hover:underline' title={row.name}>
              {row.name}
            </Link>
            <ModelSwitch row={row} editing={editing} busy={busy} onToggle={onToggle} />
            <span className='font-mono text-muted-foreground'>{fmtContext(row.contextWindow)}</span>
            <span className='text-right font-mono tabular-nums'>{fmtCost(row.inputPer1M)}</span>
            <span className='text-right font-mono tabular-nums'>{fmtCost(row.outputPer1M)}</span>
          </div>
        ))}
      </div>
    </Section>
  )
}

/** A pending save must lock the control without drawing every enabled
 *  model as off. Toggle's own disabled state intentionally renders off
 *  for unavailable settings, so the fieldset handles this transient lock. */
function ModelSwitch({
  row,
  editing,
  busy,
  onToggle
}: {
  row: ModelRow
  editing: boolean
  busy: boolean
  onToggle: (model: string, next: boolean) => void
}) {
  const { t } = useTranslation()
  const label = t('providers.models.switchModel', { model: row.name })
  if (!editing) return <SwitchReading on={row.enabled} label={label} />
  return (
    <fieldset disabled={busy} className='m-0 inline-flex border-0 p-0 disabled:opacity-50'>
      <Toggle on={row.enabled} label={label} onClick={() => onToggle(row.name, !row.enabled)} />
    </fieldset>
  )
}
