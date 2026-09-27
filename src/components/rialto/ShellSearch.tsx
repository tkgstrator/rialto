import { cn } from 'cn'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { NAV } from './shell-navigation'

/**
 * Command palette over every destination in the tree.
 *
 * Once all the sub-views are rows in one menu the menu is long enough that
 * typing beats hunting — it is the same affordance that keeps Cloudflare's
 * own deep sidebar usable, and the reason the search box earns the slot
 * above the tree.
 */
export function NavSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (next: boolean) => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const go = useCallback(
    (href: string) => {
      onOpenChange(false)
      navigate(href)
    },
    [navigate, onOpenChange]
  )
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title={t('shell.search')}>
      <CommandInput placeholder={t('shell.searchPlaceholder')} />
      <CommandList>
        <CommandEmpty>{t('shell.searchEmpty')}</CommandEmpty>
        {NAV.map((section) => (
          <CommandGroup key={section.id} heading={t(section.labelKey)}>
            <CommandItem value={t(section.labelKey)} onSelect={() => go(section.href)}>
              <i aria-hidden className={cn(section.icon, 'text-base leading-none opacity-80')} />
              {t(section.labelKey)}
            </CommandItem>
            {section.children.map((child) => (
              <CommandItem
                key={child.id}
                // The section name is in the value so "activity logs"
                // finds the child the way the breadcrumb reads it.
                value={`${t(section.labelKey)} ${t(child.labelKey)}`}
                onSelect={() => go(child.href)}
              >
                <i aria-hidden className={cn(child.icon, 'text-base leading-none opacity-80')} />
                {t(child.labelKey)}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
