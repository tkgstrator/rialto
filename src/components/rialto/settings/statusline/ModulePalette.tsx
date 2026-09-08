/**
 * The "add a module" column.
 *
 * Only the types `rialto statusline` can actually render are listed —
 * offering a type the renderer drops would produce a line that silently
 * loses a segment.
 */
import { useTranslation } from 'react-i18next'
import { MODULE_TYPES } from '@/lib/rialto/settings-content/statusline'

export function ModulePalette({ onAdd }: { onAdd: (type: string) => void }) {
  const { t } = useTranslation()
  return (
    <aside className='min-w-0 overflow-y-auto border-r border-border'>
      <div className='px-4 pt-5 pb-2'>
        <h2 className='text-[12px] font-semibold uppercase tracking-wider text-muted-foreground'>
          {t('settings.statusline.addModule')}
        </h2>
      </div>
      {MODULE_TYPES.map((meta) => (
        <button
          key={meta.type}
          type='button'
          onClick={() => onAdd(meta.type)}
          className='flex w-full items-center gap-2.5 border-l-2 border-l-transparent px-4 py-2 text-left text-xs transition-colors hover:border-l-border hover:bg-muted/50'
        >
          <i className={`${meta.icon} text-sm leading-none text-muted-foreground`} />
          {meta.label}
          <i className='ri-add-line ml-auto text-sm text-muted-foreground/40' />
        </button>
      ))}
    </aside>
  )
}
