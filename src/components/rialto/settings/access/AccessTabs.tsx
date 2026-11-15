/**
 * Tokens / Plans — the two lists behind Access tokens.
 *
 * Tokens is the issued list; Plans is what a token on one may spend.
 */
import { useTranslation } from 'react-i18next'
import { Tabs } from '@/components/rialto/primitives'

export type AccessTab = 'tokens' | 'plans'

export function AccessTabs({ active }: { active: AccessTab }) {
  const { t } = useTranslation()
  return (
    // Tighter on a phone so the first tab's label lines up with the 16px
    // gutter the phone layout uses, as the shell's own section strip does.
    // `[&>a]:min-w-20 [&>a]:justify-center` makes each tab (and so its
    // underline) at least 5rem wide and centers the label inside, so the
    // underlines under "Tokens" and "Plans" are the same length instead of
    // following each label's natural text width.
    <div className='flex items-center gap-1 border-b border-border px-1 md:px-6 [&>a]:min-w-20 [&>a]:justify-center'>
      <Tabs
        active={active}
        items={[
          { id: 'tokens', label: t('access.tabs.tokens'), href: '/access-tokens' },
          { id: 'plans', label: t('access.tabs.plans'), href: '/access-tokens/plans' }
        ]}
      />
    </div>
  )
}
