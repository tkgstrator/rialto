/**
 * The line as the terminal will print it.
 *
 * Colours are painted from the module's own resolved hex rather than a
 * Tailwind class, because the value being edited is an ANSI name or a
 * literal hex that a terminal will honour — an approximation here would
 * make the preview a different design surface from the artefact.
 */
import { useTranslation } from 'react-i18next'
import { Pill } from '@/components/rialto/primitives'
import { colorHex, previewText } from '@/lib/rialto/settings-content/statusline'
import { cn } from '@/lib/utils'
import type { StatusLineModuleConfig } from '@/types'

const STYLES = [
  { id: 'default', labelKey: 'settings.statusline.styleDefault' },
  { id: 'powerline', labelKey: 'settings.statusline.stylePowerline' }
]

function Segment({ module, powerline }: { module: StatusLineModuleConfig; powerline: boolean }) {
  const fg = colorHex(module.color)
  const bg = colorHex(module.background)
  return (
    <span
      className={cn('whitespace-pre', powerline ? 'px-2 py-0.5' : '')}
      style={{
        color: fg === null ? undefined : fg,
        backgroundColor: powerline && bg !== null ? bg : undefined
      }}
    >
      {previewText(module)}
    </span>
  )
}

export function LinePreview({
  modules,
  style,
  onStyleChange
}: {
  modules: StatusLineModuleConfig[]
  style: string
  onStyleChange: (style: string) => void
}) {
  const { t } = useTranslation()
  const powerline = style === 'powerline'
  return (
    <div className='border-b border-border px-6 py-5'>
      <div className='flex items-center gap-2'>
        <h3 className='text-sm font-semibold'>{t('settings.statusline.preview')}</h3>
        <Pill tone='ok'>{t('settings.statusline.live')}</Pill>
      </div>
      <div className='mt-3 rounded-md border border-border bg-[#0d0d0d] px-4 py-3'>
        <div className={cn('flex items-center font-mono text-[12px] text-neutral-300', powerline ? 'gap-0' : 'gap-3')}>
          {modules.length === 0 ? (
            <span className='text-neutral-500'>{t('settings.statusline.emptyLine')}</span>
          ) : (
            modules.map((module, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the line is an ordered list of unnamed segments
              <Segment key={`${module.type}-${index}`} module={module} powerline={powerline} />
            ))
          )}
        </div>
      </div>
      <div className='mt-2 flex gap-2'>
        {STYLES.map((option) => (
          <button
            key={option.id}
            type='button'
            onClick={() => onStyleChange(option.id)}
            className={cn(
              'rounded border px-2 py-0.5 text-[11px] transition-colors',
              option.id === style
                ? 'border-foreground/40 text-foreground'
                : 'border-border text-muted-foreground hover:bg-muted/50'
            )}
          >
            {t(option.labelKey)}
          </button>
        ))}
      </div>
    </div>
  )
}
