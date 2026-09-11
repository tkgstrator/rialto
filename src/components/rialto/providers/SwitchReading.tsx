/**
 * A switch's state, with nothing to press.
 *
 * A provider's page reads until Edit is pressed, and its switches were the
 * easiest thing on it to flip by accident. `Toggle` cannot stand in with
 * `disabled`: a disabled Toggle paints OFF, because there it means nothing
 * reads the flag. Here the flag is live and only the page is locked, so
 * the state stays on screen, at half strength. Same markup as Toggle, so
 * pressing Edit changes the switch's strength and nothing about its place.
 */
import { cn } from 'cn'

export function SwitchReading({ on, label, title }: { on: boolean; label: string; title?: string }) {
  return (
    <button
      type='button'
      disabled
      aria-pressed={on}
      aria-label={label}
      title={title}
      className='align-middle opacity-50'
    >
      <span
        className={cn(
          'inline-flex h-4 w-7 items-center rounded-full px-0.5 align-middle',
          on ? 'bg-foreground' : 'bg-muted-foreground/30'
        )}
      >
        <span className={cn('size-3 rounded-full bg-background', on ? 'translate-x-3' : '')} />
      </span>
    </button>
  )
}
