/**
 * Route picker for one tier group.
 *
 * A route is a provider and a tier on it, so the list is every enabled
 * provider's four tiers — grouped by provider, because that is the choice
 * the operator makes first — each with the model its alias names today.
 * Showing the model is what keeps "claude-code · sonnet" from being an
 * abstraction: the operator sees what they are about to route to, and an
 * unset alias is visible before the route exists rather than after.
 *
 * A provider · tier already in the group stays in the list, disabled and
 * labelled, rather than vanishing: a missing row reads as "that provider
 * has no such tier", which is the wrong conclusion.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pill, RButton } from '@/components/rialto/primitives'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { hasRoute, routeKey } from './derive'
import type { DraftRoute } from './types'
import { MODEL_TIERS } from './types'

function AliasModel({ model, known }: { model: string | null; known: boolean }) {
  const { t } = useTranslation()
  // Unknown is the alias list having failed to load: say nothing rather
  // than claim an alias is unset.
  if (!known) return null
  if (model === null) {
    return <span className='text-[12px] text-amber-600 dark:text-amber-400'>{t('routing.tiers.stateAliasUnset')}</span>
  }
  return <span className='min-w-0 truncate font-mono text-muted-foreground'>{model}</span>
}

export function AddRouteDialog({
  tierLabel,
  routes,
  providers,
  aliases,
  onAdd
}: {
  /** The group's translated name, for the title. */
  tierLabel: string
  /** The group's current routes, for refusing a duplicate. */
  routes: readonly DraftRoute[]
  providers: readonly string[]
  /** Provider · tier → the model its alias names, or null where none is set. */
  aliases: ReadonlyMap<string, string | null>
  onAdd: (route: DraftRoute) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const options = useMemo(
    () =>
      providers.map((provider) => ({
        provider,
        tiers: MODEL_TIERS.map((tier) => ({
          tier,
          taken: hasRoute(routes, provider, tier),
          known: aliases.has(routeKey(provider, tier)),
          model: aliases.get(routeKey(provider, tier))
        }))
      })),
    [providers, routes, aliases]
  )

  return (
    <>
      <RButton variant='ghost' icon='ri-add-line' onClick={() => setOpen(true)}>
        {t('routing.tiers.addRoute')}
      </RButton>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className='p-0 sm:max-w-lg'>
          <DialogHeader className='px-4 pt-4'>
            <DialogTitle className='text-sm'>{t('routing.tiers.addRouteTitle', { tier: tierLabel })}</DialogTitle>
          </DialogHeader>
          <Command>
            <CommandInput placeholder={t('routing.tiers.searchProviders')} />
            <CommandList>
              <CommandEmpty>{t('routing.tiers.noProviders')}</CommandEmpty>
              {options.map((option) => (
                <CommandGroup key={option.provider} heading={<span className='font-mono'>{option.provider}</span>}>
                  {option.tiers.map((choice) => (
                    <CommandItem
                      key={choice.tier}
                      value={`${option.provider} ${choice.tier}`}
                      disabled={choice.taken}
                      className='text-xs'
                      onSelect={() => {
                        onAdd({ provider: option.provider, targetTier: choice.tier, enabled: true })
                        setOpen(false)
                      }}
                    >
                      {/* A fixed slot for the tier, so the model names
                          line up down their left edge — the edge the eye
                          reads down — instead of starting wherever each
                          4-6 character tier word happens to end. */}
                      <span className='flex w-16 shrink-0 items-center'>
                        <Pill tone='mute'>{choice.tier}</Pill>
                      </span>
                      <AliasModel model={choice.model === undefined ? null : choice.model} known={choice.known} />
                      {choice.taken ? (
                        <span className='ml-auto shrink-0 text-[12px] text-muted-foreground'>
                          {t('routing.tiers.alreadyInTier')}
                        </span>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  )
}
