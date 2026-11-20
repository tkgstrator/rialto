import { Fragment, type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { TokenFolder } from '@/shared/access-token-policy'

export type MoveToken = (tokenId: string, folderId: string | null) => void
export const TOKEN_DRAG_TYPE = 'application/x-rialto-token'

export function TokenFolderBrowser({
  folders,
  folderId,
  onOpen,
  renderTokens,
  onMove,
  table = false
}: {
  folders: readonly TokenFolder[]
  folderId: string | null
  onOpen: (id: string | null) => void
  renderTokens: (id: string | null, depth: number) => ReactNode
  onMove?: MoveToken
  table?: boolean
}) {
  const { t } = useTranslation()
  const [dropTarget, setDropTarget] = useState<string | null | undefined>()
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const expanded = new Set<string>()
  let current = folderId === null ? undefined : byId.get(folderId)
  while (current !== undefined && !expanded.has(current.id)) {
    expanded.add(current.id)
    current = current.parentId === null ? undefined : byId.get(current.parentId)
  }

  const byParent = new Map<string | null, TokenFolder[]>()
  for (const folder of [...folders].sort((left, right) => left.name.localeCompare(right.name))) {
    const siblings = byParent.get(folder.parentId)
    if (siblings === undefined) byParent.set(folder.parentId, [folder])
    else siblings.push(folder)
  }

  const folderRow = (folder: TokenFolder | null, depth: number) => {
    const id = folder === null ? null : folder.id
    const open = folder === null || expanded.has(folder.id)
    const contents = (
      <Button
        type='button'
        variant='ghost'
        aria-expanded={folder === null ? undefined : open}
        className={`h-10 w-full justify-start gap-2 rounded-none pr-4 md:pr-6 ${onMove && dropTarget === id ? 'bg-muted ring-1 ring-inset ring-primary' : ''}`}
        style={{ paddingInlineStart: `${1.5 + Math.min(depth, 5) * 0.75}rem` }}
        onClick={() => onOpen(open && folder !== null ? folder.parentId : id)}
        onDragOver={(event) => {
          if (onMove === undefined || !event.dataTransfer.types.includes(TOKEN_DRAG_TYPE)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setDropTarget(id)
        }}
        onDragLeave={() => setDropTarget(undefined)}
        onDrop={(event) => {
          setDropTarget(undefined)
          const tokenId = event.dataTransfer.getData(TOKEN_DRAG_TYPE)
          if (onMove === undefined || !tokenId) return
          event.preventDefault()
          onMove(tokenId, id)
        }}
      >
        <i aria-hidden className={open ? 'ri-arrow-down-s-line' : 'ri-arrow-right-s-line'} />
        <i aria-hidden className={open ? 'ri-folder-open-line' : 'ri-folder-line'} />
        <span className='min-w-0 truncate'>{folder === null ? t('settings.access.folderRoot') : folder.name}</span>
      </Button>
    )
    return table ? (
      <tr className='border-t border-border bg-muted/25'>
        <td colSpan={8}>{contents}</td>
      </tr>
    ) : (
      <div className='border-t border-border bg-muted/25'>{contents}</div>
    )
  }

  const renderFolders = (parentId: string | null, depth: number): ReactNode =>
    byParent.get(parentId)?.map((folder) => (
      <Fragment key={folder.id}>
        {folderRow(folder, depth)}
        {expanded.has(folder.id) ? (
          <>
            {renderTokens(folder.id, depth + 1)}
            {renderFolders(folder.id, depth + 1)}
          </>
        ) : null}
      </Fragment>
    ))

  return (
    <>
      {onMove === undefined ? null : folderRow(null, 0)}
      {renderFolders(null, 0)}
      {renderTokens(null, 0)}
    </>
  )
}
