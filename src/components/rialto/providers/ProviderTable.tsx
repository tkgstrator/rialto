/**
 * One kind of provider, as a list.
 *
 * This was an 18rem rail beside the detail it selected into — a second
 * navigation column, grouped under exactly the two headings the sidebar
 * now carries. Removing it gives the detail page the 288px its account
 * emails and price columns were short of.
 *
 * The two kinds do not share columns, and the branch below is the point
 * rather than an accident: a subscription has accounts, a plan and a
 * window that runs out, and no per-request price; an api_key provider has
 * a secret and a price list and nothing that expires on its own. A table
 * carrying the union would render four dashes a row on one side.
 */
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Meter, Pill } from '@/components/rialto/primitives'
import { SortTh, type SortValue, useTableSort } from '@/components/rialto/table-sort'
import {
  enabledCountOf,
  listedModelsOf,
  maskKeyParts,
  type ProviderState,
  planOf,
  providerQuotaPct,
  type QuotaIndex
} from './derive'
import type { Provider, SubscriptionWire } from './types'

const STATE_TONE = { off: 'mute', live: 'ok', invalid: 'bad', unknown: 'mute' } as const

const STATE_LABEL_KEYS: Record<ProviderState, string> = {
  off: 'providers.rail.stateOff',
  live: 'providers.rail.stateLive',
  invalid: 'providers.rail.stateInvalid',
  unknown: 'providers.rail.stateUnknown'
}

export interface ListedProvider {
  provider: Provider
  /** Catalog display name when the vendor is known, else the config slug. */
  label: string
  /** Catalog vendor family, else the host the provider actually calls. */
  vendor: string
  state: ProviderState
  subscription: SubscriptionWire | undefined
}

type SortKey = 'provider' | 'plan' | 'accounts' | 'quota' | 'key' | 'models' | 'state'

const accountIdsOf = (sub: SubscriptionWire | undefined): string[] =>
  sub === undefined ? [] : sub.accounts.map((a) => a.id)

/** The host a key is spent against — the second line of an api_key row. */
const hostOf = (provider: Provider): string => new URL(provider.api_base_url).host

/**
 * A provider can exist with no key at all — the column has to say so,
 * because it is the reason that provider's models never answer. The
 * schema spells "none" two ways (null from a provider that never had
 * one, empty string from one whose key was cleared) and both are it.
 */
const hasKey = (provider: Provider): boolean => provider.api_key !== null && provider.api_key !== ''

/**
 * A key in a fixed-width cell.
 *
 * The bullets are the only part that carries nothing, so they are the
 * only part allowed to disappear: a cell narrow enough to clip
 * "sk-proj-••••••••••••N44A" clips the tail, which is the half that says
 * which of two OpenAI keys is configured. `maskKeyParts` splits it for
 * exactly this.
 */
function MaskedKey({ value }: { value: string }) {
  const { head, bullets, tail } = maskKeyParts(value)
  return (
    <span className='flex min-w-0 items-baseline'>
      <span className='shrink-0'>{head}</span>
      <span className='min-w-0 truncate'>{bullets}</span>
      <span className='shrink-0'>{tail}</span>
    </span>
  )
}

/**
 * The line under a provider's name.
 *
 * The vendor under a subscription, because Claude Code is Anthropic's and
 * the two names are not the same word. The host under an API key, because
 * there they usually are — an "OpenAI / OpenAI" row says nothing twice —
 * and the URL a key is spent against is the fact that identifies it.
 */
function SubLine({ entry }: { entry: ListedProvider }) {
  if (entry.provider.auth_mode === 'subscription') {
    return <div className='text-[12px] text-muted-foreground'>{entry.vendor}</div>
  }
  return <div className='font-mono text-[12px] text-muted-foreground'>{hostOf(entry.provider)}</div>
}

function Row({
  entry,
  subscriptionKind,
  quota
}: {
  entry: ListedProvider
  subscriptionKind: boolean
  quota: QuotaIndex
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { provider, subscription } = entry
  const plan = planOf(subscription)
  const accounts = accountIdsOf(subscription)
  const pct = providerQuotaPct(quota, accounts)
  const open = () => navigate(`/providers/${encodeURIComponent(provider.name)}`)
  return (
    // A row rather than a Link: a `<tr>` cannot legally hold one, and the
    // cells have to stay cells for the columns to line up. Enter opens it
    // so the list is walkable without a mouse.
    <tr
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open()
      }}
      tabIndex={0}
      className='cursor-pointer border-t border-border/60 transition-colors hover:bg-muted/50'
    >
      <td className='py-2.5 pl-6 pr-3'>
        <div className='text-xs font-medium'>{entry.label}</div>
        <SubLine entry={entry} />
      </td>
      {subscriptionKind ? (
        <>
          <td className='px-3'>{plan === null ? null : <Pill tone='info'>{plan}</Pill>}</td>
          <td className='px-3 text-right font-mono text-xs tabular-nums'>{accounts.length}</td>
          <td className='px-3'>
            {pct === null ? (
              <span className='text-[12px] text-muted-foreground/50'>—</span>
            ) : (
              <div className='flex items-center gap-2'>
                <div className='min-w-0 flex-1'>
                  <Meter pct={pct} />
                </div>
                <span className='shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground'>{pct}%</span>
              </div>
            )}
          </td>
        </>
      ) : (
        // "not set" is a real row rather than an empty cell: a provider
        // can exist with no key, and it is the reason its models never
        // answer. Masked and read-only, the same as on its own page.
        <td className='px-3 font-mono text-[12px] text-muted-foreground'>
          {hasKey(provider) ? <MaskedKey value={String(provider.api_key)} /> : t('providers.list.noKey')}
        </td>
      )}
      <td className='px-3 text-right font-mono text-xs tabular-nums'>
        {enabledCountOf(provider)} / {listedModelsOf(provider).length}
      </td>
      <td className='px-3 text-right'>
        <Pill tone={STATE_TONE[entry.state]}>{t(STATE_LABEL_KEYS[entry.state])}</Pill>
      </td>
      <td className='py-2.5 pl-3 pr-6'>
        <div className='flex justify-end text-muted-foreground/50'>
          <i className='ri-arrow-right-s-line text-base' />
        </div>
      </td>
    </tr>
  )
}

export function ProviderTable({
  entries,
  kind,
  quota
}: {
  entries: ListedProvider[]
  kind: 'subscription' | 'api_key'
  quota: QuotaIndex
}) {
  const { t } = useTranslation()
  const subscriptionKind = kind === 'subscription'

  // A provider with no plan, no key or no quota reading sorts last in
  // both directions — null here means unknown, and an unread quota is not
  // an empty one.
  const sort = useTableSort<ListedProvider, SortKey>(entries, (entry, key): SortValue => {
    switch (key) {
      case 'provider':
        return entry.label
      case 'plan':
        return planOf(entry.subscription)
      case 'accounts':
        return accountIdsOf(entry.subscription).length
      case 'quota':
        return providerQuotaPct(quota, accountIdsOf(entry.subscription))
      case 'key':
        return hasKey(entry.provider) ? hostOf(entry.provider) : null
      case 'models':
        return enabledCountOf(entry.provider)
      default:
        return entry.state
    }
  })

  return (
    <table className='w-full table-fixed'>
      <colgroup>
        <col />
        {subscriptionKind ? (
          <>
            <col className='w-24' />
            <col className='w-24' />
            <col className='w-40' />
          </>
        ) : (
          <col className='w-56' />
        )}
        <col className='w-24' />
        <col className='w-24' />
        {/* Just the chevron — an affordance, not a value to order by. */}
        <col className='w-10' />
      </colgroup>
      <thead>
        <tr className='text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:whitespace-nowrap [&>th]:align-bottom [&>th]:pb-2'>
          <SortTh sortKey='provider' sort={sort} className='pl-6 pr-3 text-left'>
            {t('providers.list.colProvider')}
          </SortTh>
          {subscriptionKind ? (
            <>
              <SortTh sortKey='plan' sort={sort} className='px-3 text-left'>
                {t('providers.list.colPlan')}
              </SortTh>
              <SortTh sortKey='accounts' sort={sort} className='px-3 text-right' align='right'>
                {t('providers.list.colAccounts')}
              </SortTh>
              <SortTh sortKey='quota' sort={sort} className='px-3 text-right' align='right'>
                {t('providers.list.colQuota')}
              </SortTh>
            </>
          ) : (
            <SortTh sortKey='key' sort={sort} className='px-3 text-left'>
              {t('providers.list.colKey')}
            </SortTh>
          )}
          <SortTh sortKey='models' sort={sort} className='px-3 text-right' align='right'>
            {t('providers.list.colModels')}
          </SortTh>
          <SortTh sortKey='state' sort={sort} className='px-3 text-right' align='right'>
            {t('providers.list.colState')}
          </SortTh>
          <th className='pl-3 pr-6' />
        </tr>
      </thead>
      <tbody>
        {sort.sorted.map((entry) => (
          <Row key={entry.provider.name} entry={entry} subscriptionKind={subscriptionKind} quota={quota} />
        ))}
      </tbody>
    </table>
  )
}
