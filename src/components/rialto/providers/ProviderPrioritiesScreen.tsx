import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Pill, RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { api } from '@/lib/api'
import type { ModelProviderPrioritiesResponse, ModelProviderPriority } from '@/schemas/api/model-provider-priorities'

function PriorityRow({
  row,
  saving,
  onSave
}: {
  row: ModelProviderPriority
  saving: boolean
  onSave: (model: string, providers: string[]) => void
}) {
  const { t } = useTranslation()
  const configured = row.preferredProviders.length > 0
  const order = row.providers
  const move = (index: number, by: number) => {
    const next = [...order]
    const other = index + by
    if (other < 0 || other >= next.length) return
    const current = next[index]
    next[index] = next[other]
    next[other] = current
    onSave(row.model, next)
  }
  return (
    <div className='grid gap-3 border-t border-border/60 px-6 py-4 md:grid-cols-[14rem_minmax(0,1fr)] md:gap-6 max-md:px-4'>
      <div className='min-w-0'>
        <div className='truncate font-mono text-xs' title={row.model}>
          {row.model}
        </div>
        <div className='mt-1'>
          <Pill tone={configured ? 'ok' : 'warn'}>
            {t(configured ? 'providers.priorities.configured' : 'providers.priorities.unconfigured')}
          </Pill>
        </div>
      </div>
      <div className='min-w-0 space-y-2'>
        <select
          aria-label={t('providers.priorities.primaryFor', { model: row.model })}
          value={configured ? row.preferredProviders[0] : ''}
          disabled={saving}
          onChange={(event) => {
            const primary = event.target.value
            if (primary.length > 0)
              onSave(row.model, [primary, ...row.providers.filter((provider) => provider !== primary)])
          }}
          className='h-8 w-full max-w-sm rounded-md border border-border bg-background px-2 font-mono text-xs disabled:opacity-50'
        >
          <option value=''>{t('providers.priorities.choose')}</option>
          {row.providers.map((provider) => (
            <option key={provider} value={provider}>
              {provider}
            </option>
          ))}
        </select>
        {configured ? (
          <div className='space-y-1'>
            {order.map((provider, index) => (
              <div key={provider} className='flex max-w-sm items-center gap-2 text-xs'>
                <span className='w-5 shrink-0 font-mono text-muted-foreground'>{index + 1}</span>
                <span className='min-w-0 flex-1 truncate font-mono'>{provider}</span>
                <button
                  type='button'
                  disabled={saving || index === 0}
                  onClick={() => move(index, -1)}
                  aria-label={t('providers.priorities.moveUp', { provider })}
                  className='rounded px-1.5 py-1 text-muted-foreground hover:bg-muted disabled:opacity-30'
                >
                  <i aria-hidden className='ri-arrow-up-line' />
                </button>
                <button
                  type='button'
                  disabled={saving || index === order.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label={t('providers.priorities.moveDown', { provider })}
                  className='rounded px-1.5 py-1 text-muted-foreground hover:bg-muted disabled:opacity-30'
                >
                  <i aria-hidden className='ri-arrow-down-line' />
                </button>
              </div>
            ))}
            <button
              type='button'
              disabled={saving}
              onClick={() => onSave(row.model, [])}
              className='pt-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50'
            >
              {t('providers.priorities.clear')}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function ProviderPrioritiesScreen() {
  const { t } = useTranslation()
  const [rows, setRows] = useState<ModelProviderPriority[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const reload = useCallback(() => {
    setError(null)
    api
      .get<ModelProviderPrioritiesResponse>('/models/provider-priorities')
      .then((response) => setRows(response.models))
      .catch((cause: unknown) => {
        setRows(null)
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }, [])
  useEffect(() => reload(), [reload])

  const save = async (model: string, providers: string[]) => {
    if (saving) return
    setSaving(true)
    try {
      await api.put('/models/provider-priorities', { model, providers })
      const response = await api.get<ModelProviderPrioritiesResponse>('/models/provider-priorities')
      setRows(response.models)
      toast.success(t('providers.priorities.saved'))
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Screen subtitle={t('providers.priorities.subtitle')}>
      <div className='min-w-0'>
        <div className='flex flex-wrap items-center gap-3 px-6 pt-6 pb-3 max-md:px-4'>
          <h2 className='text-sm font-semibold'>{t('providers.priorities.title')}</h2>
          <span className='text-[12px] text-muted-foreground'>{t('providers.priorities.hint')}</span>
          <div className='ml-auto'>
            <RButton variant='outline' icon='ri-refresh-line' onClick={reload} disabled={saving}>
              {t('providers.screen.refresh')}
            </RButton>
          </div>
        </div>
        {error ? (
          <p role='alert' className='border-t border-border/60 px-6 py-4 text-xs text-destructive max-md:px-4'>
            {error}
          </p>
        ) : null}
        {rows === null && !error ? (
          <p className='border-t border-border/60 px-6 py-4 text-xs text-muted-foreground max-md:px-4'>
            {t('common.loading')}
          </p>
        ) : null}
        {rows?.length === 0 ? (
          <p className='border-t border-border/60 px-6 py-4 text-xs text-muted-foreground max-md:px-4'>
            {t('providers.priorities.empty')}
          </p>
        ) : null}
        {rows?.map((row) => (
          <PriorityRow key={row.model} row={row} saving={saving} onSave={save} />
        ))}
      </div>
    </Screen>
  )
}
