/**
 * Tokens / Plans — the two lists behind Access tokens.
 *
 * Tokens is the issued list; Plans is what a token on one may spend.
 *
 * Each tab carries its count, fetched here once rather than threaded
 * through two screens that each know only their own.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tabs } from '@/components/rialto/primitives'
import { api } from '@/lib/api'
import { tokenState } from '@/lib/rialto/settings/access-tokens'

export type AccessTab = 'tokens' | 'plans'

interface Counts {
  tokens: number
  plans: number
}

export function AccessTabs({ active }: { active: AccessTab }) {
  const { t } = useTranslation()
  const [counts, setCounts] = useState<Counts | null>(null)

  useEffect(() => {
    const now = Date.now()
    Promise.all([api.getAccessTokens(), api.getPlans()])
      .then(([tokens, plans]) =>
        setCounts({
          // Live tokens, the same figure the Tokens list leads with.
          tokens: tokens.tokens.filter((token) => tokenState(token, now) === 'active').length,
          plans: plans.plans.length
        })
      )
      .catch(() => {
        // The counts decorate the tabs; the tabs still navigate without them.
      })
  }, [])

  const count = (key: keyof Counts) => (counts === null ? undefined : counts[key])
  return (
    // Tighter on a phone so the first tab's label lines up with the 16px
    // gutter the phone layout uses, as the shell's own section strip does.
    <div className='flex items-center gap-1 border-b border-border px-1 md:px-6'>
      <Tabs
        active={active}
        items={[
          { id: 'tokens', label: t('access.tabs.tokens'), count: count('tokens'), href: '/access-tokens' },
          { id: 'plans', label: t('access.tabs.plans'), count: count('plans'), href: '/access-tokens/plans' }
        ]}
      />
    </div>
  )
}
