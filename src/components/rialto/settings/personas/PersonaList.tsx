/**
 * The persona library column.
 *
 * A persona that is not the active one is not applied to anything, so it
 * renders dimmed with an `off` pill — the list answers "which of these is
 * actually costing me tokens" before it answers anything else.
 */

import { cn } from 'cn'
import { useTranslation } from 'react-i18next'
import { Pill, RButton } from '@/components/rialto/primitives'
import { countWords, type PersonaDraft } from '@/lib/rialto/settings-content/persona'

function PersonaRow({
  persona,
  selected,
  active,
  onSelect
}: {
  persona: PersonaDraft
  selected: boolean
  active: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation()
  return (
    <button
      type='button'
      onClick={onSelect}
      className={cn(
        'block w-full border-l-2 px-4 py-3 text-left transition-colors',
        selected ? 'border-l-foreground bg-muted/60' : 'border-l-transparent hover:border-l-border hover:bg-muted/50',
        active ? '' : 'opacity-45'
      )}
    >
      <div className='flex items-center gap-2'>
        <span className='text-xs font-medium'>{persona.name}</span>
        {active ? null : <Pill tone='mute'>{t('settings.personas.off')}</Pill>}
        <span className='ml-auto font-mono text-[12px] tabular-nums text-muted-foreground'>
          {t('settings.personas.wordCount', { n: countWords(persona.prompt) })}
        </span>
      </div>
      <div className='mt-0.5 text-[12px] text-muted-foreground'>
        {active ? t('settings.personas.allRoutedRequests') : '—'}
      </div>
    </button>
  )
}

export function PersonaList({
  personas,
  selectedId,
  activeId,
  onSelect,
  onCreate
}: {
  personas: PersonaDraft[]
  selectedId: string | null
  activeId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
}) {
  const { t } = useTranslation()
  return (
    <aside className='min-w-0 overflow-y-auto border-r border-border'>
      <div className='flex items-center gap-2 px-4 pt-5 pb-2'>
        <h2 className='text-[12px] font-semibold uppercase tracking-wider text-muted-foreground'>
          {t('settings.rail.personas')}
        </h2>
        <span className='ml-auto font-mono text-[11px] text-muted-foreground'>{personas.length}</span>
      </div>
      {personas.map((persona) => (
        <PersonaRow
          key={persona.id}
          persona={persona}
          selected={persona.id === selectedId}
          active={persona.id === activeId}
          onSelect={() => onSelect(persona.id)}
        />
      ))}
      <div className='p-4'>
        <RButton variant='outline' icon='ri-add-line' onClick={onCreate}>
          {t('settings.personas.newPersona')}
        </RButton>
      </div>
      <div className='border-t border-border px-4 py-4'>
        <p className='text-[12px] leading-relaxed text-muted-foreground'>{t('settings.personas.libraryNote')}</p>
      </div>
    </aside>
  )
}
