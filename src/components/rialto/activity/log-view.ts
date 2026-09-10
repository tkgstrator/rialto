/**
 * The vocabulary the Logs screen and its lines agree on.
 *
 * Extracted from the screen because a chip's gutter colour and its text
 * colour are two tables keyed by the same four values, read from the
 * toolbar and from the rows. Split them and a fifth level — or a renamed
 * one — has to be found in two places; here it is one edit and the
 * compiler names the rest.
 */
import type { LogLevel } from '@/components/rialto/activity/log-lines'

// The four levels an operator actually filters on. `fatal` folds into
// error and `trace` into debug so no line can hide from every chip.
export type LevelChip = 'error' | 'warn' | 'info' | 'debug'

export const LEVEL_CHIPS: readonly LevelChip[] = ['error', 'warn', 'info', 'debug']

export const chipFor = (level: LogLevel): LevelChip => {
  if (level === 'fatal' || level === 'error') return 'error'
  if (level === 'warn') return 'warn'
  if (level === 'info') return 'info'
  return 'debug'
}

export const GUTTER: Record<LevelChip, string> = {
  error: 'bg-destructive',
  warn: 'bg-amber-500',
  info: 'bg-transparent',
  debug: 'bg-transparent'
}

export const LEVEL_TEXT: Record<LevelChip, string> = {
  error: 'text-destructive',
  warn: 'text-amber-600 dark:text-amber-400',
  info: 'text-muted-foreground/60',
  debug: 'text-muted-foreground/60'
}
