import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { TokenFolder } from '@/shared/access-token-policy'

export function TokenFolderBrowser({
  folders,
  folderId,
  onOpen,
  renderTokens
}: {
  folders: readonly TokenFolder[]
  folderId: string | null
  onOpen: (id: string | null) => void
  renderTokens: (id: string) => ReactNode
}) {
  const { t } = useTranslation()
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

  const renderFolders = (parentId: string | null, depth: number): ReactNode => {
    const children = byParent.get(parentId)
    if (children === undefined) return null
    return (
      <ul aria-label={parentId === null ? t('settings.access.folder') : undefined}>
        {children.map((folder) => {
          const open = expanded.has(folder.id)
          return (
            <li key={folder.id} className='border-t border-border'>
              <Button
                type='button'
                variant='ghost'
                aria-expanded={open}
                className='h-10 w-full justify-start gap-2 rounded-none pr-4 md:pr-6'
                style={{ paddingInlineStart: `${1 + Math.min(depth, 5) * 0.75}rem` }}
                onClick={() => onOpen(open ? folder.parentId : folder.id)}
              >
                <i aria-hidden className={open ? 'ri-arrow-down-s-line' : 'ri-arrow-right-s-line'} />
                <i aria-hidden className={open ? 'ri-folder-open-line' : 'ri-folder-line'} />
                <span className='min-w-0 truncate'>{folder.name}</span>
              </Button>
              {open ? (
                <>
                  {renderFolders(folder.id, depth + 1)}
                  {renderTokens(folder.id)}
                </>
              ) : null}
            </li>
          )
        })}
      </ul>
    )
  }

  return renderFolders(null, 0)
}
