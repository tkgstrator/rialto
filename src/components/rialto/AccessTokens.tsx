import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Screen } from '@/components/rialto/Screen'
import { AccessTabs } from '@/components/rialto/settings/access/AccessTabs'
import { AccessTokensSection } from '@/components/rialto/settings/access/AccessTokensSection'
import { api, type InboundSurfaceWire } from '@/lib/api'

export function AccessTokens() {
  const { t } = useTranslation()
  const [surfaces, setSurfaces] = useState<InboundSurfaceWire[]>([])

  useEffect(() => {
    api
      .getInboundSurfaces()
      .then((res) => setSurfaces(res.surfaces))
      .catch(() => {})
  }, [])

  return (
    <Screen subtitle={t('settings.access.tokensSubtitle')}>
      <AccessTabs active='tokens' />
      <AccessTokensSection surfaces={surfaces} />
      <div className='h-8' />
    </Screen>
  )
}
