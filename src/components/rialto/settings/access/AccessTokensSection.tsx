import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useConfig } from '@/components/ConfigProvider'
import { scopePaths } from '@/components/rialto/activity/use-surfaces'
import { useConfirm } from '@/components/rialto/ConfirmDialog'
import { RButton } from '@/components/rialto/primitives'
import { IssuedTokenDialog } from '@/components/rialto/settings/access/IssuedTokenDialog'
import { emptyDraft, type IssueDraft, IssueTokenDialog } from '@/components/rialto/settings/access/IssueTokenDialog'
import { ANY, scopeForWire } from '@/components/rialto/settings/access/pickers'
import { TokenFolderBrowser } from '@/components/rialto/settings/access/TokenFolderBrowser'
import { TokenFolderDialog } from '@/components/rialto/settings/access/TokenFolderDialog'
import { TokenListPhone } from '@/components/rialto/settings/access/TokenListPhone'
import { TokenTable } from '@/components/rialto/settings/access/TokenTable'
import { usePhone } from '@/hooks/use-phone'
import { type AccessTokenWire, api, type InboundSurfaceWire, type PlanWire } from '@/lib/api'
import { enabledTargets } from '@/lib/models/enabled-targets'
import { expiryToIso } from '@/lib/rialto/settings/access-tokens'
import { folderTokenDefaults, type TokenFolder } from '@/shared/access-token-policy'

interface Revealed {
  plaintext: string
  name: string
  scope: string
  expiry: string
}

export function AccessTokensSection({ surfaces }: { surfaces: InboundSurfaceWire[] }) {
  const { t } = useTranslation()
  const { config } = useConfig()
  const [folders, setFolders] = useState<TokenFolder[]>([])
  const [folderId, setFolderId] = useState<string | null>(null)
  const [moving, setMoving] = useState(false)
  const inFlightMoves = useRef(new Set<string>())
  const [editingFolder, setEditingFolder] = useState<TokenFolder | null | undefined>(undefined)
  const [tokens, setTokens] = useState<AccessTokenWire[]>([])
  const [plans, setPlans] = useState<PlanWire[]>([])
  const [draft, setDraft] = useState<IssueDraft | null>(null)
  const [revealed, setRevealed] = useState<Revealed | null>(null)
  const [issuing, setIssuing] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createdNote, setCreatedNote] = useState<string | null>(null)
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [now, setNow] = useState(Date.now())
  const phone = usePhone()

  const available = useMemo(
    () => (config === null ? [] : enabledTargets(config.Providers).map((target) => target.target)),
    [config]
  )

  const closeDialog = () => {
    setDraft(null)
    setCreating(false)
    setCreatedNote(null)
  }

  const onPlanCreated = (plan: PlanWire) => {
    setPlans((prev) => [...prev, plan])
    setDraft((prev) => (prev === null ? prev : { ...prev, planId: plan.id }))
    setCreatedNote(plan.name)
    api
      .getPlans()
      .then((res) => setPlans(res.plans))
      .catch(() => {})
  }

  const load = useCallback(() => {
    api
      .getAccessTokens()
      .then((res) => {
        setTokens(res.tokens)
        setNow(Date.now())
      })
      .catch((e: Error) => toast.error(t('settings.access.listFailed', { message: e.message })))
  }, [t])

  useEffect(() => {
    load()
    api
      .getTokenFolders()
      .then((res) => setFolders(res.folders))
      .catch((error: Error) => toast.error(t('settings.access.listFailed', { message: error.message })))
    api
      .getPlans()
      .then((res) => setPlans(res.plans))
      .catch(() => {})
  }, [load, t])

  const issue = () => {
    if (draft === null) return
    setIssuing(true)
    api
      .issueAccessToken({
        name: draft.name.trim(),
        folderId: draft.folderId,
        policy: draft.policy,
        surfaces: scopeForWire(surfaces, draft.surfaces),
        expiresAt: expiryToIso(draft.expiry, Date.now()),
        planId: draft.planId === ANY ? null : draft.planId
      })
      .then((res) => {
        const paths = scopePaths(surfaces, res.token.surfaces)
        setRevealed({
          plaintext: res.plaintext,
          name: res.token.name,
          scope: paths.length === 0 ? t('settings.access.allEndpoints') : paths.join(', '),
          expiry: res.token.expiresAt === null ? t('settings.access.never') : res.token.expiresAt.slice(0, 10)
        })
        closeDialog()
        load()
      })
      .catch((e: Error) => toast.error(t('settings.access.issueFailed', { message: e.message })))
      .finally(() => setIssuing(false))
  }

  const resetAll = async () => {
    const confirmed = await confirm({
      title: t('access.token.resetAllTitle'),
      description: [
        { text: t('access.token.resetAllBody') },
        { text: t('access.token.resetAllWarning'), tone: 'destructive' },
        { text: t('access.token.resetAllKeeps') }
      ],
      confirmLabel: t('access.token.resetAll'),
      icon: 'ri-restart-line'
    })
    if (!confirmed) return
    setResetting(true)
    api
      .resetAllUsageWindows()
      .then(() => toast.success(t('access.token.allResetNote')))
      .catch((e: Error) => toast.error(t('access.token.resetFailed', { message: e.message })))
      .finally(() => setResetting(false))
  }

  const selectedFolder = folders.find((folder) => folder.id === folderId)
  const visibleTokens = tokens.filter((token) => (token.folderId === undefined ? null : token.folderId) === folderId)
  const newToken = () => {
    const defaults = folderTokenDefaults(selectedFolder)
    setDraft({
      ...emptyDraft(),
      folderId,
      planId: defaults.planId === null ? ANY : defaults.planId,
      policy: defaults.policy
    })
  }
  const removeFolder = async (folder: TokenFolder) => {
    const accepted = await confirm({
      title: t('settings.access.folderDelete'),
      description: [{ text: t('settings.access.folderDeleteConfirm', { name: folder.name }) }],
      confirmLabel: t('settings.access.folderDelete'),
      icon: 'ri-delete-bin-line'
    })
    if (!accepted) return
    try {
      await api.deleteTokenFolder(folder.id)
      setFolders((previous) => previous.filter((item) => item.id !== folder.id))
      setFolderId(folder.parentId)
    } catch (error) {
      toast.error(t('settings.common.saveFailed', { message: error instanceof Error ? error.message : String(error) }))
    }
  }
  const moveToken = async (id: string, destination: string | null) => {
    const token = tokens.find((entry) => entry.id === id)
    if (
      !moving ||
      token === undefined ||
      (token.folderId === undefined ? null : token.folderId) === destination ||
      inFlightMoves.current.has(id)
    )
      return
    if (destination !== null && !folders.some((folder) => folder.id === destination)) return
    inFlightMoves.current.add(id)
    try {
      await api.updateAccessToken(id, { folderId: destination })
      setTokens((previous) => previous.map((entry) => (entry.id === id ? { ...entry, folderId: destination } : entry)))
      setFolderId(destination)
    } catch (error) {
      toast.error(t('settings.common.saveFailed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      inFlightMoves.current.delete(id)
    }
  }
  const onMove = moving ? moveToken : undefined
  const toolbar = (
    <div className='flex flex-wrap items-center gap-2 px-6 pt-5 pb-3 max-md:px-4'>
      <RButton variant='outline' icon='ri-folder-add-line' onClick={() => setEditingFolder(null)}>
        {t('settings.access.folderNew')}
      </RButton>
      {selectedFolder === undefined ? null : (
        <>
          <RButton variant='outline' icon='ri-pencil-line' onClick={() => setEditingFolder(selectedFolder)}>
            {t('settings.access.folderEdit')}
          </RButton>
          <RButton
            variant='danger'
            icon='ri-delete-bin-line'
            onClick={() => removeFolder(selectedFolder)}
            disabled={visibleTokens.length > 0 || folders.some((folder) => folder.parentId === selectedFolder.id)}
          >
            {t('settings.access.folderDelete')}
          </RButton>
        </>
      )}
      <RButton variant='outline' onClick={() => setMoving(!moving)} className='ml-auto'>
        {t(moving ? 'common.done' : 'common.edit')}
      </RButton>
      <RButton variant='primary' icon='ri-add-line' onClick={newToken}>
        {t('settings.access.issueToken')}
      </RButton>
    </div>
  )

  const dialogs = (
    <>
      {revealed !== null ? (
        <IssuedTokenDialog {...revealed} onDone={() => setRevealed(null)} />
      ) : draft !== null ? (
        <IssueTokenDialog
          draft={draft}
          surfaces={surfaces}
          plans={plans}
          folders={folders}
          available={available}
          creating={creating}
          createdNote={createdNote}
          issuing={issuing}
          onChange={(next) => {
            if (draft !== null && next.planId !== draft.planId) setCreatedNote(null)
            setDraft(next)
          }}
          onSubmit={issue}
          onCancel={closeDialog}
          onCreatingChange={setCreating}
          onDismissCreatedNote={() => setCreatedNote(null)}
          onPlanCreated={onPlanCreated}
        />
      ) : null}
      {editingFolder !== undefined ? (
        <TokenFolderDialog
          folder={editingFolder}
          parentId={folderId}
          folders={folders}
          plans={plans}
          onClose={() => setEditingFolder(undefined)}
          onSaved={(folder) => {
            setFolders((previous) => [...previous.filter((item) => item.id !== folder.id), folder])
            setFolderId(editingFolder === null ? folder.parentId : folder.id)
            setEditingFolder(undefined)
          }}
        />
      ) : null}
      {confirmDialog}
    </>
  )

  return (
    <>
      {toolbar}
      {phone ? (
        <TokenFolderBrowser
          folders={folders}
          folderId={folderId}
          onOpen={setFolderId}
          onMove={onMove}
          renderTokens={(id, depth) => (
            <TokenListPhone
              tokens={tokens.filter((token) => (token.folderId === undefined ? null : token.folderId) === id)}
              now={now}
              depth={depth}
              folders={folders}
              onMove={onMove}
            />
          )}
        />
      ) : (
        <div className='overflow-x-auto'>
          <TokenTable
            tokens={tokens}
            surfaces={surfaces}
            now={now}
            folders={folders}
            onMove={onMove}
            renderTree={(renderTokens) => (
              <TokenFolderBrowser
                table
                folders={folders}
                folderId={folderId}
                onOpen={setFolderId}
                onMove={onMove}
                renderTokens={renderTokens}
              />
            )}
          />
        </div>
      )}
      <div aria-hidden className='h-16' />
      <RButton
        variant='danger'
        icon='ri-restart-line'
        onClick={resetAll}
        disabled={resetting}
        className='fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-20 bg-destructive text-white shadow-sm hover:bg-destructive/90 hover:text-white md:right-6'
      >
        {t('access.token.resetAll')}
      </RButton>
      {dialogs}
    </>
  )
}
