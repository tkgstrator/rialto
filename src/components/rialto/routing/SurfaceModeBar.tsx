/**
 * The controls that act on the selected surface: whether the router
 * applies to it at all, and which preference profile it draws from.
 *
 * These render inside `SurfaceBar`'s trailing slot rather than as a band
 * of their own — see the comment there. The mode switch writes straight
 * through: there is no draft state for a boolean whose whole purpose is
 * to be flipped and observed. Both controls change what actually routes:
 * `scenario-router.ts` resolves the surface for the inbound path and runs
 * that surface's profile.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* The label lives inside the trigger now. As a separate
            <span> beside it, "Profile" was one more free-floating word
            in a band that already carries four surface tabs and a
            two-position switch. */}
        <button
          type='button'
          className='inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-muted/60'
        >
          <span className='text-muted-foreground'>{t('routing.chain.profile')}</span>
          {current}
          <i className='ri-arrow-down-s-line text-sm text-muted-foreground' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-60 p-1'>
        {/* The reserved passthrough profile is deliberately not offered
            here. Selecting it on a surface would mean exactly what the
            Routed/Passthrough toggle to the left already means, and two
            controls for one decision is how they end up disagreeing on
            screen. It stays available for access tokens, where it is the
            only way to express it. */}
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
  )
}

export function SurfaceControls({
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
    <>
      <Segmented
        value={surface.routingMode}
        options={[
          { value: 'routed', label: t('routing.chain.modeRoutedLabel') },
          { value: 'passthrough', label: t('routing.chain.modePassthroughLabel') }
        ]}
        onChange={onMode}
      />
      {/* The two-line paragraph that used to hold the right half of a
          band of its own is this marker. The routed/passthrough
          distinction matters once, when you first meet the switch — not
          on every later visit — and the band it was crowding is the one
          that has to fit four surface tabs beside it. */}
      <button
        type='button'
        title={t('routing.chain.modeHelp')}
        aria-label={t('routing.chain.modeHelp')}
        className='text-muted-foreground/60 hover:text-foreground'
      >
        <i className='ri-question-line text-sm' />
      </button>
      {/* A passthrough surface draws from no profile, so the picker is
          absent rather than disabled — and the divider goes with it. */}
      {surface.routingMode === 'routed' ? (
        <>
          <span className='h-4 w-px bg-border' />
          <ProfilePicker current={surface.profileKey} profiles={profiles} onSelect={onProfile} />
        </>
      ) : null}
    </>
  )
}
