/**
 * Band 1 of the Routing screens: which inbound surface.
 *
 * The surface is the outermost axis — whether the router applies at all
 * is a per-surface fact — so it comes first.
 *
 * Every tab is the same shape: a dot and a path, filled dot for routed
 * and hollow for passthrough. Uniform on purpose. The selected surface's
 * controls used to sit at the right end of this row, where a switch on
 * the same line as four tabs reads as governing the row rather than one
 * tab, and nothing on it said which surface it wrote to. Moving them
 * inside the selected tab only traded that for a row that stretches and
 * reflows on every switch. They live in a scope strip of their own now
 * (`SurfaceScopeBar`), directly under this one.
 *
 * The dot still carries each surface's mode, which is the fact this
 * screen exists to stop hiding: the old build bypassed the router on two
 * surfaces and said so nowhere.
 */
import type { InboundSurfaceWire, SurfaceId } from '@/lib/api'
import { cn } from '@/lib/utils'

export function SurfaceBar({
  surfaces,
  active,
  onSelect
}: {
  surfaces: readonly InboundSurfaceWire[]
  active: SurfaceId | null
  onSelect: (id: SurfaceId) => void
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
          </button>
        )
      })}
    </div>
  )
}
