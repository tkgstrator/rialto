/**
 * "Who guards what" — the three credentials an operator confuses with
 * each other, and the direction each one points.
 *
 * Static reference copy, not state: the whole reason the panel exists is
 * that "API key" means an inbound gate on two of these and an outbound
 * secret on the third, and nothing else on the screen says so.
 */
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

interface Guard {
  id: string
  titleKey: string
  accent: string
  /** Arrow diagrams, identical in every language — kept out of the bundle. */
  flow: string
  body: React.ReactNode
}

const GUARDS: Guard[] = [
  {
    id: 'cloudflareAccess',
    titleKey: 'settings.access.guardAccessTitle',
    accent: 'border-l-emerald-500/60',
    flow: 'you → Access → Rialto',
    body: <Trans i18nKey='settings.access.guardAccessBody' components={{ mono: <span className='font-mono' /> }} />
  },
  {
    id: 'accessToken',
    titleKey: 'settings.access.guardTokenTitle',
    accent: 'border-l-foreground/40',
    flow: 'Claude Code → Rialto',
    body: <Trans i18nKey='settings.access.guardTokenBody' components={{ mono: <span className='font-mono' /> }} />
  },
  {
    id: 'providerApiKey',
    titleKey: 'settings.access.guardProviderTitle',
    accent: 'border-l-border',
    flow: 'Rialto → OpenAI',
    body: (
      <Trans
        i18nKey='settings.access.guardProviderBody'
        components={{
          strong: <span className='font-medium text-foreground' />,
          providers: <Link to='/providers' className='underline underline-offset-2' />
        }}
      />
    )
  }
]

export function GuardsCard() {
  const { t } = useTranslation()
  return (
    <div className='rounded-md border border-border px-4 py-3'>
      <div className='text-[12px] font-semibold uppercase tracking-wider text-muted-foreground'>
        {t('settings.access.whoGuardsWhat')}
      </div>
      <div className='mt-2 grid grid-cols-3 gap-4'>
        {GUARDS.map((g) => (
          <div key={g.id} className={`border-l-2 ${g.accent} pl-3`}>
            <div className='text-xs font-medium'>{t(g.titleKey)}</div>
            <div className='mt-1 text-[12px] leading-relaxed text-muted-foreground'>{g.body}</div>
            <div className='mt-1.5 font-mono text-[11px] text-muted-foreground'>{g.flow}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
