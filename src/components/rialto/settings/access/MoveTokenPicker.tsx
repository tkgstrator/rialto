import { useTranslation } from 'react-i18next'
import type { AccessTokenWire } from '@/lib/api'
import type { TokenFolder } from '@/shared/access-token-policy'
import type { MoveToken } from './TokenFolderBrowser'
import { FolderPicker } from './TokenPolicyFields'

export function MoveTokenPicker({
  token,
  folders,
  onMove
}: {
  token: AccessTokenWire
  folders: readonly TokenFolder[]
  onMove: MoveToken
}) {
  const { t } = useTranslation()
  return (
    <FolderPicker
      label={t('settings.access.moveToken', { name: token.name })}
      folders={folders}
      value={token.folderId === undefined ? null : token.folderId}
      onChange={(id) => onMove(token.id, id)}
    />
  )
}
