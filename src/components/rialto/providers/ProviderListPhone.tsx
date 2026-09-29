/**
 * One kind of provider as a phone list.
 *
 * A row keeps the one figure each kind is checked for: how much of a
 * subscription's quota is spent, and whether an API-key provider is live.
 * Plan, account count, host and the model tally ride on the second line;
 * the masked key and the sort headers stay on the desktop table.
 */
import { useTranslation } from 'react-i18next'
import { Meter, PhoneRow, Pill } from '@/components/rialto/primitives'
import { enabledCountOf, listedModelsOf, planOf, providerQuotaPct, type QuotaIndex } from './derive'
import { accountsOf, hostOf, type ListedProvider, STATE_LABEL_KEYS, STATE_TONE, seatKindOf } from './ProviderTable'

const hrefOf = (entry: ListedProvider): string => `/providers/${encodeURIComponent(entry.provider.name)}`

function StatePill({ entry }: { entry: ListedProvider }) {
  const { t } = useTranslation()
  return <Pill tone={STATE_TONE[entry.state]}>{t(STATE_LABEL_KEYS[entry.state])}</Pill>
}

function SubscriptionRow({ entry, quota }: { entry: ListedProvider; quota: QuotaIndex }) {
  const plan = planOf(entry.subscription)
  const accounts = accountsOf(entry.subscription)
  const pct = providerQuotaPct(quota, seatKindOf(entry.subscription), accounts)
  return (
    <PhoneRow
      href={hrefOf(entry)}
      primary={<span className='font-medium'>{entry.label}</span>}
      trailing={
        pct === null ? (
          '—'
        ) : (
          // A short bar beside the figure: 91% and 19% differ by one
          // glyph, and the colour is what says which one needs a look.
          <span className='flex items-center gap-2'>
            <span className='w-16'>
              <Meter pct={pct} />
            </span>
            {pct}%
          </span>
        )
      }
      secondary={
        <>
          {plan === null ? null : <Pill tone='info'>{plan}</Pill>}
          <span className='truncate'>{entry.vendor}</span>
          {/* A count beside a person glyph: "accounts" spelled out would
              take the width the vendor name needs. */}
          <span className='inline-flex shrink-0 items-center gap-1 font-mono tabular-nums'>
            <i aria-hidden className='ri-user-line' />
            {accounts.length}
          </span>
          <span className='ml-auto shrink-0'>
            <StatePill entry={entry} />
          </span>
        </>
      }
    />
  )
}

function ApiKeyRow({ entry }: { entry: ListedProvider }) {
  const { t } = useTranslation()
  return (
    <PhoneRow
      href={hrefOf(entry)}
      primary={<span className='font-medium'>{entry.label}</span>}
      trailing={<StatePill entry={entry} />}
      secondary={
        <>
          <span className='min-w-0 truncate font-mono'>{hostOf(entry.provider)}</span>
          <span className='ml-auto shrink-0'>
            {t('providers.models.enabledCount', {
              enabled: enabledCountOf(entry.provider),
              total: listedModelsOf(entry.provider).length
            })}
          </span>
        </>
      }
    />
  )
}

export function ProviderListPhone({
  entries,
  kind,
  quota
}: {
  entries: ListedProvider[]
  kind: 'subscription' | 'api_key'
  quota: QuotaIndex
}) {
  return (
    <div className='pb-2'>
      {entries.map((entry) =>
        kind === 'subscription' ? (
          <SubscriptionRow key={entry.provider.name} entry={entry} quota={quota} />
        ) : (
          <ApiKeyRow key={entry.provider.name} entry={entry} />
        )
      )}
    </div>
  )
}
