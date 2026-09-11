/**
 * A fenced block from a captured turn.
 *
 * Its own scroll container: a transcript is a column of prose, and one
 * 200-character line of minified JSON must not be able to widen the
 * column every other turn is measured against.
 *
 * The palette is four classes because the highlighter emits four (see
 * `lib/sessions/code`). They are picked from the app's own tokens rather
 * than a highlighting theme — a second colour system inside the shell
 * would be one more thing to keep in step with light and dark.
 */

import { cn } from 'cn'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type TokenKind, tokenizeCode } from '@/lib/sessions/code'

const TOKEN_CLASS: Record<TokenKind, string> = {
  plain: '',
  comment: 'text-muted-foreground/70',
  string: 'text-emerald-600 dark:text-emerald-400',
  keyword: 'text-sky-600 dark:text-sky-400',
  number: 'text-amber-600 dark:text-amber-400'
}

export function CodeBlock({ lang, body }: { lang: string; body: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const tokens = tokenizeCode(body, lang)

  const copy = () => {
    // A clipboard write can be refused (an insecure origin, a denied
    // permission). The label is the only feedback there is, so it moves
    // only once the write resolved.
    navigator.clipboard
      .writeText(body)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => setCopied(false))
  }

  return (
    <div className='mt-2 overflow-hidden rounded-md border border-border'>
      <div className='flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5'>
        <span className='font-mono text-[11px] uppercase tracking-wider text-muted-foreground'>
          {lang === '' ? t('activity.session.codePlain') : lang}
        </span>
        <button
          type='button'
          onClick={copy}
          className='ml-auto text-[11px] text-muted-foreground transition-colors hover:text-foreground'
        >
          {t(copied ? 'common.copied' : 'common.copy')}
        </button>
      </div>
      <pre className='overflow-x-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed'>
        <code>
          {tokens.map((token, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the block is an ordered run of unnamed tokens
            <span key={`${token.kind}-${index}`} className={cn(TOKEN_CLASS[token.kind])}>
              {token.text}
            </span>
          ))}
        </code>
      </pre>
    </div>
  )
}
