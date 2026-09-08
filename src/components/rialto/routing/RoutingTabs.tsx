/**
 * The two tab strips the Routing screens share.
 *
 * `SurfaceTabs` is the outermost axis of the Chain view: you pick the wire
 * format you are configuring before anything else, because whether the
 * router applies at all is a per-surface fact. `ViewTabs` is the ordinary
 * sub-view strip the Map and Rules screens carry.
 */
import { useTranslation } from 'react-i18next'
import type { InboundSurfaceWire, SurfaceId } from '@/lib/api'
import { cn } from '@/lib/utils'

export function SurfaceTabs({
  surfaces,
  active,
  onSelect
}: {
  surfaces: readonly InboundSurfaceWire[]
  active: SurfaceId | null
  onSelect: (id: SurfaceId) => void
}) {
  const { t } = useTranslation()
  return (
    <div className='flex items-stretch gap-0 border-b border-border px-2'>
      {surfaces.map((surface) => {
        const on = surface.id === active
        return (
          <button
            key={surface.id}
            type='button'
            onClick={() => onSelect(surface.id)}
            className={cn(
              'relative flex flex-col items-start gap-0.5 border-b-2 px-4 py-2.5 text-left transition-colors',
              on ? 'border-b-foreground' : 'border-b-transparent hover:bg-muted/50'
            )}
          >
            <span className={cn('font-mono text-xs', on ? 'text-foreground' : 'text-muted-foreground')}>
              {surface.path}
            </span>
            <span className='flex items-center gap-1.5 text-[12px] text-muted-foreground'>
              {`${surface.client} · `}
              {surface.routingMode === 'routed' ? (
                <span className='text-emerald-600 dark:text-emerald-400'>{t('routing.common.modeRouted')}</span>
              ) : (
                t('routing.common.modePassthrough')
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
