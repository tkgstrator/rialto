/**
 * A provider's page at phone width.
 *
 * Reading only. What is worth checking away from a desk is whether the
 * provider is live, how much of each account's quota is spent, which key
 * it sends and which models it serves — so the page keeps the header,
 * the accounts (or the credential) and the switched-on models. Request
 * shape, the tier strip, the model table's prices-and-capabilities grid
 * and Edit stay on the desktop page: a staged edit across a 390px model
 * table is not a change anyone should be making on a phone, and the tier
 * a model serves is still on its row below.
 *
 * Test all stays. It writes nothing but test results, and "is this
 * provider answering" is exactly the question a phone check-in asks.
 */
import { useTranslation } from 'react-i18next'
import { PhoneRow, Pill, RButton, Toggle } from '@/components/rialto/primitives'
import { usePhone } from '@/hooks/use-phone'
import { fmtCost } from '@/lib/sessions/format'
import { AccountsPanel } from './AccountsPanel'
import { CredentialsPanel } from './CredentialsPanel'
import { buildModelRows, enabledCountOf, fmtContext, hasCredential, listedModelsOf, type ModelRow } from './derive'
import { TestIcon, TierCell } from './ModelsTable'
import { ProviderDetail, type ProviderDetailProps } from './ProviderDetail'
import { STATE_LABEL_KEYS, STATE_TONE } from './ProviderTable'
import { SwitchReading } from './SwitchReading'

/**
 * Models as phone rows: name and test result on the first line, the
 * tiers that reach it and its context window on the second, and on an
 * api_key provider the in / out price that Routing's cost ordering reads.
 *
 * With `onToggle` the test result gives way to the model's switch — the
 * add-provider flow's last step, where choosing models is the whole job.
 */
export function PhoneModelList({
  rows,
  priced,
  onToggle
}: {
  rows: readonly ModelRow[]
  priced: boolean
  onToggle?: (model: string, next: boolean) => void
}) {
  const { t } = useTranslation()
  return (
    <div className='pb-2'>
      {rows.map((row) => (
        <PhoneRow
          key={row.name}
          primary={<span className='font-mono'>{row.name}</span>}
          trailing={
            onToggle === undefined ? (
              <TestIcon status={row.test} />
            ) : (
              <Toggle
                on={row.enabled}
                label={t('providers.models.toggleModel', { model: row.name })}
                onClick={() => onToggle(row.name, !row.enabled)}
              />
            )
          }
          secondary={
            <>
              {/* No dash for "no tier": on a two-line row an empty slot
                  says it as well, and the dash read as a stray rule. */}
              {row.tiers.length === 0 ? null : <TierCell row={row} />}
              {row.newer ? <Pill tone='info'>{t('providers.models.newer')}</Pill> : null}
              <span className='font-mono tabular-nums'>{fmtContext(row.contextWindow)}</span>
              {priced ? (
                <span
                  className='ml-auto shrink-0 font-mono tabular-nums'
                  title={`${t('providers.models.colIn')} / ${t('providers.models.colOut')}`}
                >
                  {fmtCost(row.inputPer1M)} / {fmtCost(row.outputPer1M)}
                </span>
              ) : null}
            </>
          }
        />
      ))}
    </div>
  )
}

export function ProviderDetailPhone(props: ProviderDetailProps) {
  const { t } = useTranslation()
  const { provider, subscription, catalogEntry } = props
  const subscriptionMode = provider.auth_mode === 'subscription'
  const credentialed = hasCredential(provider, subscription)
  // Switched-on models only: the rest are the catalogue, which is the
  // desktop table's job to browse.
  const rows = buildModelRows(provider, catalogEntry, props.tiers).filter((row) => row.enabled)
  const switchLabel = t('providers.detail.toggleProvider', { provider: props.label })
  return (
    <div className='min-w-0'>
      <div className='border-b border-border px-4 py-4'>
        <div className='flex flex-wrap items-center gap-2'>
          <h2 className='text-sm font-semibold'>{props.label}</h2>
          {subscriptionMode ? (
            <Pill tone='info'>{t('providers.connect.pillSubscription')}</Pill>
          ) : (
            <Pill tone='mute'>{t('providers.connect.pillApiKey')}</Pill>
          )}
          <Pill tone={STATE_TONE[props.state]}>{t(STATE_LABEL_KEYS[props.state])}</Pill>
        </div>
        <p className='mt-0.5 truncate font-mono text-[12px] text-muted-foreground'>{provider.api_base_url}</p>
        <div className='mt-3 flex items-center gap-3'>
          {/* Read the way the desktop header reads it outside Edit: with no
              credential the switch shows off, because nothing honours it. */}
          <span className='flex items-center gap-1.5 text-[12px] text-muted-foreground'>
            {t('providers.detail.routable')}
            <SwitchReading
              on={provider.enabled !== false && credentialed}
              title={credentialed ? undefined : t('providers.detail.routableNeedsCredential')}
              label={switchLabel}
            />
          </span>
          <RButton
            variant='outline'
            icon='ri-pulse-line'
            onClick={props.onTestAll}
            disabled={props.busy}
            className='ml-auto'
          >
            {t('providers.detail.testAll')}
          </RButton>
        </div>
      </div>
      {subscriptionMode ? (
        <AccountsPanel
          subscription={subscription}
          quota={props.quota}
          accounts={props.accounts}
          now={props.now}
          busy={props.busy}
          editing={false}
          onToggle={props.onToggleAccount}
          onUseReset={props.onUseReset}
        />
      ) : (
        <CredentialsPanel
          key={provider.name}
          provider={provider}
          label={props.label}
          editing={false}
          onReplace={props.onReplaceKey}
        />
      )}
      <div className='border-t border-border'>
        <div className='flex items-baseline gap-3 px-4 pt-5 pb-3'>
          <h3 className='text-sm font-semibold'>{t('providers.models.title')}</h3>
          <span className='text-[12px] text-muted-foreground'>
            {t('providers.models.enabledCount', {
              enabled: enabledCountOf(provider),
              total: listedModelsOf(provider).length
            })}
          </span>
        </div>
        {/* "No models" only when the provider really has none; with every
            model switched off the count above already says 0 of n. */}
        {listedModelsOf(provider).length === 0 ? (
          <div className='px-4 pb-6 text-xs text-muted-foreground'>{t('providers.models.empty')}</div>
        ) : (
          <PhoneModelList rows={rows} priced={!subscriptionMode} />
        )}
      </div>
      <div className='h-6' />
    </div>
  )
}

/**
 * The detail body at whichever width the window has. Both take the same
 * props, so the screen stages edits the same way either side of the
 * breakpoint; the phone one simply never offers Edit.
 */
export function ProviderDetailPane(props: ProviderDetailProps) {
  return usePhone() ? <ProviderDetailPhone {...props} /> : <ProviderDetail {...props} />
}
