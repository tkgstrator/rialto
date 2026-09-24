/**
 * The tier-alias strip on a provider's page: one cell per tier, saying
 * which of this provider's models a route naming it and that tier reaches.
 *
 * Routing no longer names models. A route says "claude-code · sonnet",
 * and when the vendor ships a new Sonnet this strip is the one place that
 * changes — the routes do not move. The alias never moves by itself
 * either: a refresh only lists the newer model as a candidate ("1 new"),
 * and pointing the alias at it is an edit, staged with the rest of the
 * page until Save.
 */
import { useTranslation } from 'react-i18next'
import { Pill } from '@/components/rialto/primitives'
import { type AliasMap, type AliasOptions, aliasOptions, newCountOf, TIERS } from './tier-aliases'
import type { Tier, TierAliasWire } from './types'

/**
 * The picker while editing: the bordered box the rest of the app draws
 * for "this opens a list", with a native select laid over it.
 *
 * Native for the reason the table's effort picker is — a keyboard user
 * gets the platform control — and laid over the box rather than styled
 * itself so the box can show the bare model name while the options carry
 * "current" and "new" beside theirs.
 */
function AliasPicker({
  tier,
  model,
  options,
  onPick
}: {
  tier: Tier
  model: string | null
  options: AliasOptions
  onPick: (tier: Tier, model: string | null) => void
}) {
  const { t } = useTranslation()
  return (
    <span className='relative inline-flex h-8 w-full min-w-0 items-center justify-between gap-1.5 rounded-md border border-border px-2.5 font-mono text-xs transition-colors focus-within:border-ring hover:bg-muted/60'>
      {model === null ? (
        <span className='text-muted-foreground/60'>{t('providers.aliases.unset')}</span>
      ) : (
        <span className='truncate'>{model}</span>
      )}
      <i className='ri-arrow-down-s-line text-sm text-muted-foreground' />
      <select
        aria-label={t('providers.aliases.pick', { tier })}
        value={model === null ? '' : model}
        onChange={(e) => onPick(tier, e.target.value === '' ? null : e.target.value)}
        className='absolute inset-0 cursor-pointer opacity-0'
      >
        {/* Unset is a real choice, not a placeholder: routes naming this
            tier are refused until an alias is set again. */}
        <option value=''>{t('providers.aliases.unsetReading')}</option>
        {options.current === null ? null : (
          <option value={options.current}>{t('providers.aliases.optionCurrent', { model: options.current })}</option>
        )}
        {options.candidates.length === 0 ? null : (
          <optgroup label={t('providers.aliases.groupCandidates', { tier })}>
            {options.candidates.map((c) => (
              <option key={c.model} value={c.model}>
                {c.isNew ? t('providers.aliases.optionNew', { model: c.model }) : c.model}
              </option>
            ))}
          </optgroup>
        )}
        {options.others.length === 0 ? null : (
          <optgroup label={t('providers.aliases.groupOther')}>
            {options.others.map((other) => (
              <option key={other} value={other}>
                {other}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </span>
  )
}

function AliasCell({
  tier,
  row,
  model,
  listed,
  editing,
  onPick
}: {
  tier: Tier
  row: TierAliasWire | undefined
  model: string | null
  listed: readonly string[]
  editing: boolean
  onPick: (tier: Tier, model: string | null) => void
}) {
  const { t } = useTranslation()
  const fresh = newCountOf(row)
  return (
    <div className='min-w-0 border-l-2 border-l-transparent bg-background px-4 py-3 transition-colors hover:border-l-border hover:bg-muted/50'>
      {/* Fixed height, so a "new" pill does not push this cell's model
          below its neighbours'. */}
      <div className='flex h-5 items-center gap-2'>
        <span className='text-[12px] uppercase tracking-wider text-muted-foreground/70'>{tier}</span>
        {fresh === 0 ? null : (
          <Pill tone='info' className='ml-auto'>
            {t('providers.aliases.newCount', { n: fresh })}
          </Pill>
        )}
      </div>
      <div className='mt-1.5 flex min-h-8 min-w-0 items-center'>
        {editing ? (
          <AliasPicker tier={tier} model={model} options={aliasOptions(row, listed)} onPick={onPick} />
        ) : model === null ? (
          <span className='text-[12px] text-muted-foreground/60'>{t('providers.aliases.unsetReading')}</span>
        ) : (
          <span className='truncate font-mono text-xs' title={model}>
            {model}
          </span>
        )}
      </div>
    </div>
  )
}

export function TierAliases({
  rows,
  aliases,
  listed,
  editing,
  onPick
}: {
  /** This provider's alias rows as loaded: the candidates and the "new" counts. */
  rows: readonly TierAliasWire[]
  /** The aliases as Save would leave them: as loaded while reading, with the picks applied while editing. */
  aliases: AliasMap
  /** The provider's listed models, which every picker offers beyond the tier's own candidates. */
  listed: readonly string[]
  editing: boolean
  onPick: (tier: Tier, model: string | null) => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <div className='flex items-center gap-3 px-6 pt-5 pb-3'>
        <h3 className='text-sm font-semibold'>{t('providers.aliases.title')}</h3>
        <span className='text-[12px] text-muted-foreground'>{t('providers.aliases.hint')}</span>
      </div>
      <div className='grid grid-cols-4 gap-px border-y border-border bg-border/60'>
        {TIERS.map((tier) => {
          const model = aliases[tier]
          return (
            <AliasCell
              key={tier}
              tier={tier}
              row={rows.find((row) => row.tier === tier)}
              model={model === undefined ? null : model}
              listed={listed}
              editing={editing}
              onPick={onPick}
            />
          )
        })}
      </div>
    </>
  )
}
