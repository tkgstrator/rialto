/**
 * The tier strip on a provider's page: one cell per tier, saying which of
 * this provider's models a route naming it and that tier reaches.
 *
 * Routing never names a model. A route says "claude-code · sonnet", and
 * on a tier some model names that is the newest switched-on one — a
 * reading on both sides of Edit, because the model switches in the table
 * are the control; a newer model waiting switched off is counted ("1
 * newer"). A tier no model names (Codex, an OpenAI key) keeps an alias,
 * picked here and staged with the rest of the page until Save.
 */
import { useTranslation } from 'react-i18next'
import { Pill } from '@/components/rialto/primitives'
import { type AliasOptions, aliasOptions, type TierView } from './tier-aliases'
import type { Tier } from './types'

/**
 * The picker while editing a manual tier: the bordered box the rest of the
 * app draws for "this opens a list", with a native select laid over it.
 *
 * Native for the reason the table's effort picker is — a keyboard user
 * gets the platform control — and laid over the box rather than styled
 * itself so the box can show the bare model name while the options carry
 * "current" beside theirs.
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

function TierCell({
  view,
  stored,
  listed,
  editing,
  onPick
}: {
  view: TierView
  stored: string | null
  listed: readonly string[]
  editing: boolean
  onPick: (tier: Tier, model: string | null) => void
}) {
  const { t } = useTranslation()
  return (
    <div className='min-w-0 border-l-2 border-l-transparent bg-background px-4 py-3 transition-colors hover:border-l-border hover:bg-muted/50'>
      {/* Fixed height, so a "newer" pill does not push this cell's model
          below its neighbours'. */}
      <div className='flex h-5 items-center gap-2'>
        <span className='text-[12px] uppercase tracking-wider text-muted-foreground/70'>{view.tier}</span>
        {view.newer.length === 0 ? null : (
          <Pill tone='info' className='ml-auto'>
            {t('providers.aliases.newerCount', { n: view.newer.length })}
          </Pill>
        )}
      </div>
      <div className='mt-1.5 flex min-h-8 min-w-0 flex-col justify-center'>
        {view.mode === 'derived' && view.model !== null ? (
          <>
            <span className='truncate font-mono text-xs' title={view.model}>
              {view.model}
            </span>
            <span className='text-[12px] text-muted-foreground/60'>
              {view.enabled ? t('providers.aliases.derivedReading') : t('providers.aliases.derivedOff')}
            </span>
          </>
        ) : editing ? (
          <AliasPicker tier={view.tier} model={view.model} options={aliasOptions(stored, listed)} onPick={onPick} />
        ) : view.model === null ? (
          <span className='text-[12px] text-muted-foreground/60'>{t('providers.aliases.unsetReading')}</span>
        ) : (
          <span className='truncate font-mono text-xs' title={view.model}>
            {view.model}
          </span>
        )}
      </div>
    </div>
  )
}

export function TierAliases({
  views,
  stored,
  listed,
  editing,
  onPick
}: {
  /** The tiers as Save would leave them: as loaded while reading, with the draft applied while editing. */
  views: readonly TierView[]
  /** The manual aliases as loaded, which a picker offers as "current". */
  stored: Partial<Record<Tier, string>>
  /** The provider's listed models, which a manual tier's picker offers. */
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
        {views.map((view) => {
          const current = stored[view.tier]
          return (
            <TierCell
              key={view.tier}
              view={view}
              stored={current === undefined ? null : current}
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
