/**
 * The raw config document, absorbing `JsonEditor`.
 *
 * A plain textarea over a line-number gutter rather than the Monaco
 * instance the old editor pulled in: the document is a few dozen lines
 * of settings that every other screen already edits structurally, and a
 * 3 MB editor bundle for that is a poor trade. Validity is reported by
 * the pill in the toolbar, which is the only thing Monaco was really
 * providing here.
 *
 * Note the wire document is JSON, not the JSON5 the mock's pill claims:
 * `/api/config` composes the on-disk envelope with the DB-resident
 * Providers and Router, and hands back plain JSON. Comments in the file
 * itself survive on disk; they do not survive this round trip.
 */
import { useCallback, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Pill, RButton } from '@/components/rialto/primitives'
import { InfoNotice } from '@/components/rialto/settings/notice'
import { api } from '@/lib/api'
import { formatJson, isValidJson, lineNumbers, SECRET_MASK } from '@/lib/rialto/settings/envelope'

/** Narrowing guard — the house style forbids `as`, and this document is
 *  `unknown` by construction (it is whatever /api/config returned). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Swap every stored credential for the mask before the document is
 * rendered, and swap it back on save.
 *
 * Every other screen masks these — the Providers key field hides behind
 * Reveal — and this one printed them in a textarea, which is the screen
 * most likely to be screen-shared or pasted into a bug report. Saving
 * restores whatever the operator did not touch, so masking costs them
 * nothing: a value still equal to the mask means "unchanged", not "set
 * it to bullets".
 */
const maskSecrets = (doc: unknown): unknown => {
  if (!isRecord(doc)) return doc
  const out: Record<string, unknown> = { ...doc }
  if (Array.isArray(out.Providers)) {
    out.Providers = out.Providers.map((entry) => {
      if (!isRecord(entry)) return entry
      if (typeof entry.api_key !== 'string' || entry.api_key.length === 0) return entry
      return { ...entry, api_key: SECRET_MASK }
    })
  }
  return out
}

/** Put back every credential the operator left masked, so a save never
 *  writes bullets over a real key. */
const stripMasked = (doc: unknown, original: unknown): unknown => {
  if (!isRecord(doc)) return doc
  const from = isRecord(original) ? original : {}
  const out: Record<string, unknown> = { ...doc }
  if (out.APIKEY === SECRET_MASK) out.APIKEY = from.APIKEY
  if (Array.isArray(out.Providers)) {
    const before = Array.isArray(from.Providers) ? from.Providers : []
    out.Providers = out.Providers.map((entry) => {
      if (!isRecord(entry) || entry.api_key !== SECRET_MASK) return entry
      const prior = before.find((b) => isRecord(b) && b.name === entry.name)
      return { ...entry, api_key: isRecord(prior) ? prior.api_key : '' }
    })
  }
  return out
}

// Matches the mock's per-line box: 11px text at the inherited 1.5
// line-height plus its 2px vertical padding. Applied to the gutter and
// the textarea alike so the numbers stay level with their lines.
const LINE = 'font-mono text-[12px] leading-[20.5px]'

export function ConfigDocument() {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  // The unmasked document, kept so a save can put back the credentials
  // the operator never saw.
  const [loaded, setLoaded] = useState<unknown>(null)

  const load = useCallback(() => {
    api
      .get<unknown>('/config')
      .then((raw) => {
        setLoaded(raw)
        setText(JSON.stringify(maskSecrets(raw), null, 2))
      })
      .catch((e: Error) => toast.error(t('settings.advanced.readFailed', { message: e.message })))
  }, [t])

  useEffect(load, [load])

  const valid = isValidJson(text)

  const format = () => {
    const pretty = formatJson(text)
    if (pretty === null) {
      toast.error(t('settings.advanced.cannotFormat'))
      return
    }
    setText(pretty)
  }

  const save = () => {
    if (!valid) {
      toast.error(t('settings.advanced.cannotSave'))
      return
    }
    setSaving(true)
    api
      .post<{ success: boolean; message: string }>('/config', stripMasked(JSON.parse(text), loaded))
      .then((res) => {
        toast.success(res.message)
        load()
      })
      .catch((e: Error) => toast.error(t('settings.common.saveFailed', { message: e.message })))
      .finally(() => setSaving(false))
  }

  return (
    <>
      <div className='flex items-center gap-3 border-b border-border px-6 py-3'>
        <span className='font-mono text-[12px] text-muted-foreground'>config.json</span>
        <Pill tone='mute'>JSON</Pill>
        {valid ? (
          <Pill tone='ok'>{t('settings.advanced.valid')}</Pill>
        ) : (
          <Pill tone='bad'>{t('settings.advanced.invalid')}</Pill>
        )}
        <span className='text-[12px] text-muted-foreground'>{t('settings.advanced.backupsKept')}</span>
        <div className='ml-auto flex gap-2'>
          <RButton variant='ghost' icon='ri-refresh-line' onClick={load}>
            {t('settings.advanced.reload')}
          </RButton>
          <RButton variant='ghost' icon='ri-code-line' onClick={format} disabled={!valid}>
            {t('settings.advanced.format')}
          </RButton>
          <RButton variant='primary' icon='ri-check-line' onClick={save} disabled={!valid || saving}>
            {t('common.save')}
          </RButton>
        </div>
      </div>

      <div className='flex border-b border-border py-2'>
        <div aria-hidden className='w-10 shrink-0 select-none pr-3 text-right'>
          {lineNumbers(text).map((n) => (
            <div key={n} className={`${LINE} tabular-nums text-muted-foreground/50`}>
              {n}
            </div>
          ))}
        </div>
        <textarea
          value={text}
          aria-label={t('settings.advanced.configDocument')}
          spellCheck={false}
          rows={lineNumbers(text).length}
          onChange={(e) => setText(e.target.value)}
          className={`${LINE} min-w-0 flex-1 resize-none overflow-hidden whitespace-pre bg-transparent pr-6 outline-none`}
        />
      </div>

      <div className='px-6 py-4'>
        <InfoNotice>
          <Trans i18nKey='settings.advanced.configNote' components={{ mono: <span className='font-mono' /> }} />
        </InfoNotice>
      </div>
    </>
  )
}
