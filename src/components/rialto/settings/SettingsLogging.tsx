/**
 * Settings → Logging. What the server writes down, and how long it keeps it.
 *
 * All three of the mock's groups are real envelope or archive state:
 * the pino sink (LOG / LOG_LEVEL / LOG_MAX_MB), what the archive is
 * allowed to keep (CAPTURE_REQUESTS / CAPTURE_MESSAGES /
 * REDACT_TOOL_ARGUMENTS), and the store sizes behind `GET /api/storage`.
 *
 * The capture keys are read per request rather than at boot, so a save
 * here stops a recording already in flight — which is the situation an
 * operator reaches for this switch in.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { RButton } from '@/components/rialto/primitives'
import { SectionHead, SelectField, StaticField, TextField, ToggleField } from '@/components/rialto/settings/fields'
import {
  RetentionTable,
  type StorageStats,
  type StoreId,
  type StoreStats
} from '@/components/rialto/settings/logging/RetentionTable'
import { WarnNotice } from '@/components/rialto/settings/notice'
import { SettingsLayout } from '@/components/rialto/settings/SettingsLayout'
import { useUnsavedGuard } from '@/components/rialto/settings/use-unsaved-guard'
import { api } from '@/lib/api'
import {
  captureSettings,
  DEFAULT_LOG_MAX_MB,
  type EnvelopeWire,
  fmtBytes,
  LOG_LEVELS,
  parseCount,
  totalBytes
} from '@/lib/rialto/settings/envelope'

interface LoggingDraft {
  LOG: boolean
  LOG_LEVEL: string
  LOG_MAX_MB: string
  CAPTURE_REQUESTS: boolean
  CAPTURE_MESSAGES: boolean
  REDACT_TOOL_ARGUMENTS: boolean
}

const toDraft = (w: EnvelopeWire): LoggingDraft => ({
  LOG: w.LOG === true,
  LOG_LEVEL: typeof w.LOG_LEVEL === 'string' && w.LOG_LEVEL.length > 0 ? w.LOG_LEVEL : 'info',
  // Absent on disk means the logger's own fallback, so show the value
  // that is actually in force rather than an empty box.
  LOG_MAX_MB: String(typeof w.LOG_MAX_MB === 'number' ? w.LOG_MAX_MB : DEFAULT_LOG_MAX_MB),
  ...captureSettings(w)
})

/**
 * Pruning RequestLog is the one destructive action here with a
 * non-obvious consequence: Usage and cost are computed from those rows,
 * so deleting them silently lowers historical spend. Say it in the
 * confirm, where it cannot be missed.
 */
const EXTRA_WARNING_KEYS: Partial<Record<StoreId, string>> = {
  requestLog: 'settings.logging.pruneWarnRequestLog',
  message: 'settings.logging.pruneWarnMessage'
}

function CaptureSection({
  draft,
  onChange
}: {
  draft: LoggingDraft
  onChange: <K extends keyof LoggingDraft>(key: K, value: LoggingDraft[K]) => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <SectionHead title={t('settings.logging.captureTitle')} meta={t('settings.logging.captureMeta')} />
      <ToggleField
        label={t('settings.logging.recordRequests')}
        hint={t('settings.logging.recordRequestsHint')}
        value={draft.CAPTURE_REQUESTS}
        onChange={(v) => onChange('CAPTURE_REQUESTS', v)}
      />
      <ToggleField
        label={t('settings.logging.recordMessages')}
        hint={t('settings.logging.recordMessagesHint')}
        value={draft.CAPTURE_MESSAGES}
        onChange={(v) => onChange('CAPTURE_MESSAGES', v)}
      />
      <ToggleField
        label={t('settings.logging.redactToolArgs')}
        hint={t('settings.logging.redactToolArgsHint')}
        value={draft.REDACT_TOOL_ARGUMENTS}
        onChange={(v) => onChange('REDACT_TOOL_ARGUMENTS', v)}
      />

      <div className='px-6 py-4'>
        <WarnNotice title={t('settings.logging.privacyTitle')} tag={t('settings.logging.privacyTag')}>
          {t('settings.logging.privacyBody')}
        </WarnNotice>
      </div>
    </>
  )
}

function RetentionSection({ stats, reload }: { stats: StorageStats | null; reload: () => void }) {
  const { t } = useTranslation()
  const [cutoffs, setCutoffs] = useState<Record<string, number>>({})
  const [pruning, setPruning] = useState<StoreId | null>(null)

  const prune = (store: StoreStats, days: number) => {
    const extraKey = EXTRA_WARNING_KEYS[store.id]
    const tail = extraKey === undefined ? '' : `\n\n${t(extraKey)}`
    const unit = t(store.rows === null ? 'settings.logging.unitFiles' : 'settings.logging.unitRows')
    if (!window.confirm(`${t('settings.logging.pruneConfirm', { store: store.label, unit, days })}${tail}`)) return
    setPruning(store.id)
    api
      .post<{ store: StoreId; deleted: number }>('/storage/prune', { store: store.id, olderThanDays: days })
      .then((res) => {
        toast.success(t('settings.logging.pruned', { n: res.deleted, unit, store: store.label }))
        reload()
      })
      .catch((e: Error) => toast.error(t('settings.logging.pruneFailed', { message: e.message })))
      .finally(() => setPruning(null))
  }

  const unbounded = stats === null ? 0 : stats.stores.filter((s) => s.retention === null).length

  return (
    <>
      <SectionHead
        title={t('settings.logging.retentionTitle')}
        meta={
          stats === null
            ? t('settings.logging.reading')
            : t('settings.logging.retentionMeta', {
                total: fmtBytes(totalBytes(stats.stores)),
                unbounded,
                stores: stats.stores.length
              })
        }
      />
      {stats === null ? (
        <div className='px-6 py-4 text-xs text-muted-foreground'>{t('settings.logging.measuring')}</div>
      ) : (
        <RetentionTable
          stores={stats.stores}
          cutoffs={cutoffs}
          onCutoff={(id, days) => setCutoffs({ ...cutoffs, [id]: days })}
          onPrune={prune}
          pruning={pruning}
        />
      )}
      <div className='px-6 py-4 text-[12px] leading-relaxed text-muted-foreground'>
        {t('settings.logging.retentionNote')}
      </div>
    </>
  )
}

export function SettingsLogging() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [wire, setWire] = useState<EnvelopeWire | null>(null)
  const [draft, setDraft] = useState<LoggingDraft | null>(null)
  const [stats, setStats] = useState<StorageStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const loadStats = useCallback(() => {
    api
      .get<StorageStats>('/storage')
      .then(setStats)
      .catch((e: Error) => toast.error(t('settings.logging.measureFailed', { message: e.message })))
  }, [t])

  const load = useCallback(() => {
    api
      .get<EnvelopeWire>('/config')
      .then((res) => {
        setWire(res)
        setDraft(toDraft(res))
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
    loadStats()
  }, [loadStats])

  useEffect(load, [load])

  const dirty = useMemo(
    () => wire !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(toDraft(wire)),
    [draft, wire]
  )
  useUnsavedGuard(dirty)

  const save = () => {
    if (draft === null) return
    const LOG_MAX_MB = parseCount(draft.LOG_MAX_MB)
    if (LOG_MAX_MB === null || LOG_MAX_MB === 0) {
      toast.error(t('settings.logging.rotateSizeInvalid'))
      return
    }
    setSaving(true)
    api
      .post<{ success: boolean; message: string }>('/config', {
        LOG: draft.LOG,
        LOG_LEVEL: draft.LOG_LEVEL,
        LOG_MAX_MB,
        CAPTURE_REQUESTS: draft.CAPTURE_REQUESTS,
        CAPTURE_MESSAGES: draft.CAPTURE_MESSAGES,
        REDACT_TOOL_ARGUMENTS: draft.REDACT_TOOL_ARGUMENTS
      })
      .then((res) => {
        toast.success(res.message)
        load()
      })
      .catch((e: Error) => toast.error(t('settings.common.saveFailed', { message: e.message })))
      .finally(() => setSaving(false))
  }

  const set = <K extends keyof LoggingDraft>(key: K, value: LoggingDraft[K]) => {
    if (draft !== null) setDraft({ ...draft, [key]: value })
  }

  const logFiles = stats === null ? undefined : stats.stores.find((s) => s.id === 'logFiles')
  const level = draft === null ? '–' : draft.LOG_LEVEL
  const captured = stats === null ? '–' : fmtBytes(totalBytes(stats.stores))

  return (
    <SettingsLayout
      active='logging'
      subtitle={t('settings.logging.subtitle', { level, captured })}
      headerNote={t('settings.logging.headerNote')}
      headerActions={
        <RButton variant='outline' icon='ri-external-link-line' onClick={() => navigate('/activity/logs')}>
          {t('settings.logging.openInActivity')}
        </RButton>
      }
      actions={
        <>
          <RButton
            variant='ghost'
            onClick={() => (wire === null ? undefined : setDraft(toDraft(wire)))}
            disabled={!dirty}
          >
            {t('common.discard')}
          </RButton>
          <RButton variant='primary' icon='ri-check-line' onClick={save} disabled={!dirty || saving}>
            {t('common.save')}
          </RButton>
        </>
      }
    >
      {error !== null ? (
        <div className='px-6 py-6 text-xs text-destructive'>{error}</div>
      ) : draft === null ? (
        <div className='px-6 py-6 text-xs text-muted-foreground'>{t('common.loading')}</div>
      ) : (
        <>
          <ToggleField
            label={t('settings.logging.writeToFile')}
            hint={t('settings.logging.writeToFileHint')}
            value={draft.LOG}
            onChange={(v) => set('LOG', v)}
          />
          <SelectField
            label={t('settings.logging.level')}
            hint={t('settings.logging.levelHint')}
            value={draft.LOG_LEVEL}
            options={LOG_LEVELS}
            onChange={(v) => set('LOG_LEVEL', v)}
          />
          <TextField
            label={t('settings.logging.rotateAt')}
            hint={t('settings.logging.rotateAtHint')}
            value={draft.LOG_MAX_MB}
            inputMode='numeric'
            onChange={(v) => set('LOG_MAX_MB', v)}
          />
          <StaticField
            label={t('settings.logging.keepFiles')}
            hint={t('settings.logging.keepFilesHint')}
            value={logFiles === undefined || logFiles.retention === null ? '–' : logFiles.retention}
          />
          <CaptureSection draft={draft} onChange={set} />
        </>
      )}

      <RetentionSection stats={stats} reload={loadStats} />
      <div className='h-10' />
    </SettingsLayout>
  )
}
