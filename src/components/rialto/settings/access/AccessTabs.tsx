/**
 * Tokens / Apps / Plans — the three lists behind Access tokens.
 *
 * Tokens stays the hand-issued list. What app installs minted for
 * themselves lives under Apps, a count on the app's row and a searchable
 * list on its page, so the Tokens table keeps answering "which clients
 * did I let in" instead of drowning a dozen credentials under a thousand
 * devices. Plans is what a token on one may spend, for both kinds.
 *
 * Each tab carries its count, fetched here once rather than threaded
 * through three screens that each know only their own.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tabs } from '@/components/rialto/primitives'
import { api } from '@/lib/api'
import { tokenState } from '@/lib/rialto/settings/access-tokens'

export type AccessTab = 'tokens' | 'apps' | 'plans'

interface Counts {
  tokens: number
  apps: number
  plans: number
}

export function AccessTabs({ active }: { active: AccessTab }) {
  const { t } = useTranslation()
  const [counts, setCounts] = useState<Counts | null>(null)

  useEffect(() => {
    const now = Date.now()
    Promise.all([api.getAccessTokens('manual'), api.getAuthorizedApps(), api.getPlans()])
      .then(([tokens, apps, plans]) =>
        setCounts({
          // Live tokens, the same figure the Tokens list leads with.
          tokens: tokens.tokens.filter((token) => tokenState(token, now) === 'active').length,
          apps: apps.apps.length,
          plans: plans.plans.length
        })
      )
      .catch(() => {
        // The counts decorate the tabs; the tabs still navigate without them.
      })
  }, [])

  const count = (key: keyof Counts) => (counts === null ? undefined : counts[key])
  return (
    <div className='flex items-center gap-1 border-b border-border px-6'>
      <Tabs
        active={active}
        items={[
          { id: 'tokens', label: t('access.tabs.tokens'), count: count('tokens'), href: '/access-tokens' },
          { id: 'apps', label: t('access.tabs.apps'), count: count('apps'), href: '/access-tokens/apps' },
          { id: 'plans', label: t('access.tabs.plans'), count: count('plans'), href: '/access-tokens/plans' }
        ]}
      />
    </div>
  )
}
