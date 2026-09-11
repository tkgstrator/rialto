/**
 * The assembled line, top to bottom in the order the terminal prints it
 * left to right.
 *
 * The row is a `div`, not a `button`: it carries its own remove control,
 * and a button inside a button is markup the browser hoists apart.
 */

import { cn } from 'cn'
import { Trans, useTranslation } from 'react-i18next'
import { colorHex, moduleMeta } from '@/lib/rialto/settings-content/statusline'
import type { StatusLineModuleConfig } from '@/types'

function ModuleRow({
  module,
  index,
  selected,
  onSelect,
  onRemove,
  onReorder
}: {
  module: StatusLineModuleConfig
  index: number
  selected: boolean
  onSelect: () => void
  onRemove: () => void
  onReorder: (from: number, to: number) => void
}) {
  const { t } = useTranslation()
  const meta = moduleMeta(module.type)
  const hex = colorHex(module.color)
  return (
    <div
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 border-l-2 px-4 py-2.5 text-left transition-colors',
        selected ? 'border-l-foreground bg-muted/60' : 'border-l-transparent hover:border-l-border hover:bg-muted/50'
      )}
    >
      <button
        type='button'
        onClick={onSelect}
        draggable
        onDragStart={(e) => e.dataTransfer.setData('text/plain', String(index))}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          const from = Number.parseInt(e.dataTransfer.getData('text/plain'), 10)
          if (!Number.isNaN(from) && from !== index) onReorder(from, index)
        }}
        className='flex min-w-0 flex-1 items-center gap-2 text-left'
      >
        <i className='ri-draggable text-base leading-none text-muted-foreground/50' />
        <i
          className={cn(meta.icon, 'text-sm leading-none', hex === null ? 'text-muted-foreground' : '')}
          style={hex === null ? undefined : { color: hex }}
        />
        <span className='text-xs'>{t(meta.labelKey)}</span>
      </button>
      <button
        type='button'
        aria-label={t('settings.statusline.removeModule', { module: t(meta.labelKey) })}
        onClick={onRemove}
        className='text-muted-foreground/50 hover:text-destructive'
      >
        <i className='ri-close-line text-sm' />
      </button>
    </div>
  )
}

export function LineColumn({
  modules,
  selectedIndex,
  onSelect,
  onRemove,
  onReorder
}: {
  modules: StatusLineModuleConfig[]
  selectedIndex: number | null
  onSelect: (index: number) => void
  onRemove: (index: number) => void
  onReorder: (from: number, to: number) => void
}) {
  const { t } = useTranslation()
  return (
    <aside className='min-w-0 overflow-y-auto border-r border-border'>
      <div className='flex items-center gap-2 px-4 pt-5 pb-2'>
        <h2 className='text-[12px] font-semibold uppercase tracking-wider text-muted-foreground'>
          {t('settings.statusline.line')}
        </h2>
        <span className='ml-auto font-mono text-[11px] text-muted-foreground'>{modules.length}</span>
      </div>
      {modules.map((module, index) => (
        <ModuleRow
          // Modules carry no id and the same type may appear twice (an
          // input and an output token counter), so position is identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: the line is an ordered list of unnamed segments
          key={`${module.type}-${index}`}
          module={module}
          index={index}
          selected={index === selectedIndex}
          onSelect={() => onSelect(index)}
          onRemove={() => onRemove(index)}
          onReorder={onReorder}
        />
      ))}
      <div className='border-t border-border px-4 py-4'>
        <p className='text-[12px] leading-relaxed text-muted-foreground'>
          <Trans i18nKey='settings.statusline.lineNote' components={{ mono: <span className='font-mono' /> }} />
        </p>
      </div>
    </aside>
  )
}
