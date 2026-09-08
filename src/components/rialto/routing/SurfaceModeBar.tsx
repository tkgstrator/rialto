/**
 * The bar under the surface tabs: whether the router applies to this
 * surface at all, and which preference profile it draws from.
 *
 * The mode switch writes straight through — there is no draft state for a
 * boolean whose whole purpose is to be flipped and observed. Both controls
 * change what actually routes: `scenario-router.ts` resolves the surface
 * for the inbound path and runs that surface's profile.
 */
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { InboundSurfaceWire, RoutingMode } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { ProfileSummary } from './types'

export function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (next: T) => void
}) {
  return (
    <div className='flex rounded-md border border-border p-0.5'>
      {options.map((option) => (
        <button
          key={option.value}
          type='button'
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded px-2.5 py-1 text-[12px]',
            option.value === value
              ? 'bg-foreground font-medium text-background'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function ProfilePicker({
  current,
  profiles,
  onSelect
}: {
  current: string
  profiles: readonly ProfileSummary[]
  onSelect: (key: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className='flex items-center gap-2'>
      <span className='text-xs text-muted-foreground'>{t('routing.chain.profile')}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            className='inline-flex h-7 items-center gap-2 rounded-md border border-border px-2.5 text-xs hover:bg-muted/60'
          >
            {current}
            <i className='ri-arrow-down-s-line text-sm text-muted-foreground' />
          </button>
        </PopoverTrigger>
        <PopoverContent align='start' className='w-60 p-1'>
          {/* The reserved passthrough profile is deliberately not offered
              here. Selecting it on a surface would mean exactly what the
              Routed/Passthrough toggle two controls to the left already
              means, and two controls for one decision is how they end up
              disagreeing on screen. It stays available for access
              tokens, where it is the only way to express it. */}
          {profiles
            .filter((profile) => profile.kind === 'chain')
            .map((profile) => (
              <button
                key={profile.key}
                type='button'
                onClick={() => {
                  onSelect(profile.key)
                  setOpen(false)
                }}
                className='flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60'
              >
                <span className='truncate'>{profile.key}</span>
                {/* An unconfigured profile is a real choice with a real
                  consequence, so it says so rather than showing a bare 0. */}
                {profile.entryCount === 0 ? (
                  <span className='ml-auto shrink-0 text-[11px] text-muted-foreground'>
                    {t('routing.common.notConfigured')}
                  </span>
                ) : (
                  <span className='ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground'>
                    {profile.entryCount}
                  </span>
                )}
              </button>
            ))}
        </PopoverContent>
      </Popover>
    </div>
  )
}

const EXPLAINER_KEY = {
  routed: 'routing.chain.explainerRouted',
  passthrough: 'routing.chain.explainerPassthrough'
} as const

export function SurfaceModeBar({
  surface,
  profiles,
  onMode,
  onProfile
}: {
  surface: InboundSurfaceWire
  profiles: readonly ProfileSummary[]
  onMode: (mode: RoutingMode) => void
  onProfile: (key: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className='flex items-center gap-4 border-b border-border bg-muted/30 px-6 py-3'>
      <div className='flex items-center gap-2'>
        <span className='text-xs text-muted-foreground'>{t('routing.chain.routing')}</span>
        <Segmented
          value={surface.routingMode}
          options={[
            { value: 'routed', label: t('routing.chain.modeRoutedLabel') },
            { value: 'passthrough', label: t('routing.chain.modePassthroughLabel') }
          ]}
          onChange={onMode}
        />
      </div>
      {surface.routingMode === 'routed' ? (
        <ProfilePicker current={surface.profileKey} profiles={profiles} onSelect={onProfile} />
      ) : null}
      <p className='ml-auto max-w-md text-right text-[12px] leading-snug text-muted-foreground'>
        <Trans i18nKey={EXPLAINER_KEY[surface.routingMode]} components={{ mono: <span className='font-mono' /> }} />
      </p>
    </div>
  )
}
