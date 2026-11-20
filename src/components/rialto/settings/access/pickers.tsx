import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { InboundSurfaceWire, TokenScopeId } from '@/lib/api'
import { cn } from '@/lib/utils'
import { CODEX_MCP_PATH, CODEX_MCP_SCOPE } from '@/shared/codex-mcp'

export const ANY = ''

export interface MultiPickerOption {
  label: string
  value: string
  /** Non-selectable in the list (greyed out, no toggle). Hint shown on hover. */
  disabled?: boolean
  disabledHint?: string
}

export function MultiPicker({
  id,
  options,
  selected,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyPlaceholder,
  disabled
}: {
  id?: string
  options: readonly MultiPickerOption[]
  selected: readonly string[]
  onChange: (next: string[]) => void
  placeholder: string
  searchPlaceholder?: string
  emptyPlaceholder?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const toggle = (v: string) => {
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v])
  }
  const label =
    selected.length === 0
      ? placeholder
      : options
          .filter((o) => selected.includes(o.value))
          .map((o) => o.label)
          .join(', ')
  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant='outline'
          size='sm'
          type='button'
          disabled={disabled}
          aria-expanded={open}
          className={cn(
            'inline-flex h-8 w-full max-w-md items-center justify-between rounded-md border border-border bg-transparent pl-3 pr-2 font-mono text-xs transition-colors hover:bg-muted/60 disabled:pointer-events-none disabled:opacity-50',
            selected.length === 0 ? 'text-muted-foreground' : ''
          )}
        >
          <span className='truncate text-left'>{label}</span>
          <i className='ri-arrow-down-s-line ml-2 shrink-0 text-sm text-muted-foreground' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[var(--radix-popover-trigger-width)] max-w-md p-0'>
        <Command>
          <CommandInput placeholder={searchPlaceholder} className='h-8 text-xs' />
          <CommandList>
            <CommandEmpty>{emptyPlaceholder}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const on = selected.includes(option.value)
                const off = option.disabled === true
                return (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    disabled={off}
                    onSelect={off ? undefined : () => toggle(option.value)}
                    title={off ? option.disabledHint : undefined}
                    className={cn(
                      'flex items-center gap-2 font-mono text-xs',
                      off ? 'cursor-not-allowed opacity-40' : ''
                    )}
                  >
                    <i className={cn('ri-check-line text-sm', on ? 'opacity-100' : 'opacity-0')} />
                    <span>{option.label}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function SurfacePicker({
  id,
  surfaces,
  selected,
  onChange,
  allLabel,
  showHint = true,
  disabled
}: {
  id?: string
  surfaces: readonly InboundSurfaceWire[]
  selected: readonly string[]
  onChange: (next: string[]) => void
  allLabel: string
  showHint?: boolean
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const options: MultiPickerOption[] = [
    ...surfaces.map((s) => ({ label: s.path, value: s.id })),
    { label: CODEX_MCP_PATH, value: CODEX_MCP_SCOPE }
  ]
  return (
    <div>
      <MultiPicker
        id={id}
        options={options}
        selected={selected}
        onChange={onChange}
        placeholder={allLabel}
        searchPlaceholder={t('settings.access.endpointSearchPlaceholder')}
        emptyPlaceholder={t('settings.access.endpointSearchEmpty')}
        disabled={disabled}
      />
      {showHint ? (
        <p className='mt-2 text-[12px] leading-snug text-muted-foreground'>{t('settings.access.codexMcpHint')}</p>
      ) : null}
    </div>
  )
}

export const scopeForWire = (surfaces: readonly InboundSurfaceWire[], selected: readonly string[]): TokenScopeId[] => {
  const picked: TokenScopeId[] = surfaces.filter((s) => selected.includes(s.id)).map((s) => s.id)
  return selected.includes(CODEX_MCP_SCOPE) ? [...picked, CODEX_MCP_SCOPE] : picked
}

export const sameScope = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ')
