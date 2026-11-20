import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { ProviderPriorityGroupsResponse } from '@/api/providers/priorities'
import { RButton } from '@/components/rialto/primitives'
import { Screen } from '@/components/rialto/Screen'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { ProviderPriorityGroup } from '@/shared/provider-priority'
import { vendorLabel } from './vendor-labels'

const ENDPOINT = '/providers/priorities'
type PriorityGroup = ProviderPriorityGroupsResponse['groups'][number]

function GroupOrder({
  group,
  saving,
  onSave
}: {
  group: PriorityGroup
  saving: boolean
  onSave: (group: ProviderPriorityGroup, providers: string[]) => void
}) {
  const { t } = useTranslation()
  const { providers } = group
  const move = (index: number, offset: number) => {
    const order = providers.map(({ name }) => name)
    const to = index + offset
    if (to < 0 || to >= order.length) return
    const current = order[index]
    order[index] = order[to]
    order[to] = current
    onSave(group.group, order)
  }
  if (providers.length === 0) {
    return <p className='px-3 py-2 text-xs text-muted-foreground'>{t('providers.priorities.empty')}</p>
  }
  return (
    <ol className='divide-y divide-border px-3'>
      {providers.map(({ name, organizationId, displayName }, index) => {
        const label = vendorLabel(name, displayName || vendorLabel(group.group, group.group))
        const accessibleLabel = organizationId === null ? label : `${label} ${organizationId}`
        return (
          <li key={name} className='flex items-center gap-2 py-2 text-xs'>
            <span className='w-5 shrink-0 font-mono text-muted-foreground' aria-hidden>
              {index + 1}
            </span>
            <div className='min-w-0 flex-1'>
              <div className='font-medium'>{label}</div>
              {organizationId === null ? null : (
                <div className='break-all font-mono text-muted-foreground'>{organizationId}</div>
              )}
            </div>
            <Button
              type='button'
              variant='outline'
              size='icon-sm'
              aria-label={t('providers.priorities.moveUp', { provider: accessibleLabel })}
              disabled={saving || index === 0}
              onClick={() => move(index, -1)}
            >
              <i aria-hidden className='ri-arrow-up-line' />
            </Button>
            <Button
              type='button'
              variant='outline'
              size='icon-sm'
              aria-label={t('providers.priorities.moveDown', { provider: accessibleLabel })}
              disabled={saving || index === providers.length - 1}
              onClick={() => move(index, 1)}
            >
              <i aria-hidden className='ri-arrow-down-line' />
            </Button>
          </li>
        )
      })}
    </ol>
  )
}

export function ProviderPrioritiesScreen() {
  const { t } = useTranslation()
  const [groups, setGroups] = useState<PriorityGroup[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const reload = useCallback(async () => {
    setError(null)
    try {
      setGroups((await api.get<ProviderPriorityGroupsResponse>(ENDPOINT)).groups)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])
  useEffect(() => {
    void reload()
  }, [reload])

  const save = async (group: ProviderPriorityGroup, providers: string[]) => {
    if (saving) return
    setSaving(true)
    try {
      await api.put(ENDPOINT, { group, providers })
      await reload()
      toast.success(t('providers.priorities.saved'))
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
      await reload()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Screen>
      <div className='space-y-4 px-4 py-4 md:px-6'>
        <div className='flex justify-end'>
          <RButton variant='outline' icon='ri-refresh-line' onClick={reload} disabled={saving}>
            {t('providers.screen.refresh')}
          </RButton>
        </div>
        {error ? (
          <p role='alert' className='text-xs text-destructive'>
            {error}
          </p>
        ) : null}
        {groups === null && !error ? <p className='text-xs text-muted-foreground'>{t('common.loading')}</p> : null}
        <Accordion
          type='multiple'
          defaultValue={['openai', 'anthropic']}
          className='divide-y divide-border border-y border-border'
        >
          {groups?.map((group) => (
            <AccordionItem key={group.group} value={group.group} className='border-b-0'>
              <AccordionTrigger className='px-3 py-3'>{vendorLabel(group.group, group.group)}</AccordionTrigger>
              <AccordionContent>
                <GroupOrder group={group} saving={saving} onSave={save} />
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </Screen>
  )
}
