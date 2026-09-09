/**
 * Band 1 of the Routing screens: which inbound surface, and whether the
 * router applies to it.
 *
 * The surface is the outermost axis — whether the router applies at all
 * is a per-surface fact — so it comes first. What changed is that the
 * controls acting on the selected surface now sit in the same row as the
 * tabs, passed in as `trailing`. They used to occupy a second full-width
 * strip underneath, which put a surface's mode two bands away from the
 * switch that changes it and printed the word "routed" five times.
 *
 * The mode rides each tab as a dot instead: filled for routed, hollow for
 * passthrough. The client hint ("Claude Code") rides only the selected
 * tab — on all four it wrapped every label onto two lines and pushed the
 * trailing controls off the band.
 */
import type { ReactNode } from 'react'
import type { InboundSurfaceWire, SurfaceId } from '@/lib/api'
import { cn } from '@/lib/utils'

export function SurfaceBar({
  surfaces,
  active,
  onSelect,
  trailing
}: {
  surfaces: readonly InboundSurfaceWire[]
  active: SurfaceId | null
  onSelect: (id: SurfaceId) => void
  trailing?: ReactNode
}) {
  return (
    <div className='flex items-center gap-1 border-b border-border pl-4 pr-6'>
      {surfaces.map((surface) => {
        const on = surface.id === active
        return (
          <button
            key={surface.id}
            type='button'
            onClick={() => onSelect(surface.id)}
            className={cn(
              'flex items-center gap-2 border-b-2 px-3 py-2.5 transition-colors',
              on ? 'border-b-foreground' : 'border-b-transparent hover:bg-muted/50'
            )}
          >
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                surface.routingMode === 'routed' ? 'bg-emerald-500' : 'border border-muted-foreground/50'
              )}
            />
            <span
              className={cn('whitespace-nowrap font-mono text-xs', on ? 'text-foreground' : 'text-muted-foreground')}
            >
              {surface.path}
            </span>
            {on ? (
              <span className='whitespace-nowrap text-[12px] text-muted-foreground/70'>{surface.client}</span>
            ) : null}
          </button>
        )
      })}
      {trailing === undefined ? null : <div className='ml-auto flex items-center gap-3 pl-4'>{trailing}</div>}
    </div>
  )
}
