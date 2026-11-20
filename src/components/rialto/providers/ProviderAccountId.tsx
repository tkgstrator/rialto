import { useTranslation } from 'react-i18next'
import type { Provider } from './types'
import { useProviderAccount } from './useProviderAccount'

export function ProviderAccountId({ provider }: { provider: Provider }) {
  const { t } = useTranslation()
  const { organizationId, projectId } = useProviderAccount(provider)
  const id = projectId || organizationId
  if (id === undefined) return null
  return (
    <div className='break-all text-[12px] text-muted-foreground'>
      {t(projectId ? 'providers.credentials.projectId' : 'providers.credentials.organizationId')}{' '}
      <span className='font-mono'>{id}</span>
    </div>
  )
}
