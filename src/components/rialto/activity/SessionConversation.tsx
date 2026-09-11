/**
 * Activity › Session › Conversation — what was said, newest first, a page
 * at a time.
 *
 * This pane used to share the screen with the routing trace and lost: a
 * real Claude Code session is mostly tool traffic and injected context, so
 * the transcript spent a screen's width on material nobody came to read
 * and squeezed the trace into a rail. It is back as a tab of its own, and
 * the noise is folded rather than dropped. Prose is shown; a tool call, a
 * tool result and Claude Code's injected context are one line each until
 * opened. Dropping them — which the old pane did — made a turn that was
 * only a tool call look empty.
 *
 * Newest first like every other list under Activity, so the calls on the
 * trace tab and the turns here line up page for page.
 */
import { cn } from 'cn'
import { useCallback } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useConfig } from '@/components/ConfigProvider'
import { CodeBlock } from '@/components/rialto/activity/CodeBlock'
import { fetchSessionMessages } from '@/components/rialto/activity/data'
import { ScreenMessage } from '@/components/rialto/activity/shared'
import { useSessionPage } from '@/components/rialto/activity/use-session-page'
import { Pager } from '@/components/rialto/Pager'
import type { SessionMessageItem } from '@/lib/api'
import dayjs from '@/lib/dayjs'
import { splitTurn } from '@/lib/sessions/code'
import { blockKey, type NormalisedBlock, normaliseContent } from '@/lib/sessions/message-content'

const PAGE_SIZE = 25

// A tool result can be a whole file. A folded row costs nothing, but an
// opened one lays out every character, so it stops somewhere.
const MAX_BODY_CHARS = 20_000

// The folded row's preview. CSS truncates it to the width; this only keeps
// a megabyte of JSON from being laid out just to be clipped.
const PREVIEW_CHARS = 200

type InjectedBlock = Extract<NormalisedBlock, { kind: 'system_text' }>

const isInjected = (block: NormalisedBlock): block is InjectedBlock => block.kind === 'system_text'

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS)

// Injected context arrives wrapped (`<system-reminder>…`), and a preview
// that opens on the wrapper says nothing about what is inside it.
const WRAPPER_TAG = /<\/?[a-z][\w-]*(?:\s[^>]*)?>/gi

/** One folded block: a single line until opened, then its full text. */
function Fold({
  icon,
  label,
  tag,
  preview,
  body
}: {
  icon: string
  label: string
  tag?: string
  preview: string
  body: string
}) {
  const { t } = useTranslation()
  const shown = body.slice(0, MAX_BODY_CHARS)
  const rest = body.length - shown.length
  return (
    <details className='group mt-2 rounded-md border border-border/60'>
      <summary className='flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted/50 [&::-webkit-details-marker]:hidden'>
        <i className='ri-arrow-right-s-line text-sm transition-transform group-open:rotate-90' />
        <i className={cn(icon, 'text-sm')} />
        <span className='shrink-0 font-mono text-foreground'>{label}</span>
        {tag === undefined ? null : <span className='shrink-0'>{tag}</span>}
        <span className='min-w-0 truncate font-mono'>{preview}</span>
      </summary>
      <pre className='max-h-96 overflow-auto whitespace-pre-wrap break-all border-t border-border/60 px-3 py-2.5 font-mono text-[12px] leading-relaxed'>
        {shown}
      </pre>
      {rest > 0 ? (
        <div className='border-t border-border/60 px-3 py-1.5 text-[12px] text-muted-foreground'>
          {t('activity.session.moreChars', { n: rest.toLocaleString() })}
        </div>
      ) : null}
    </details>
  )
}

/**
 * Prose and fenced code, rendered apart. As one paragraph the code wrapped
 * with the sentences around it, which is unreadable exactly where it
 * matters — the code is usually why the session was opened.
 */
function Prose({ text }: { text: string }) {
  return (
    <>
      {splitTurn(text).map((segment, index) =>
        segment.kind === 'text' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are an ordered split of one string
          <p key={`text-${index}`} className='mt-1.5 whitespace-pre-wrap break-words text-xs leading-relaxed'>
            {segment.text}
          </p>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are an ordered split of one string
          <CodeBlock key={`code-${index}`} lang={segment.lang} body={segment.body} />
        )
      )}
    </>
  )
}

function Block({ block }: { block: NormalisedBlock }) {
  const { t } = useTranslation()
  if (block.kind === 'text') return <Prose text={block.text} />
  if (block.kind === 'tool_use') {
    return (
      <Fold
        icon='ri-tools-line'
        label={block.name}
        // Capture keeps only the head of a long argument list; say so, or
        // the cut-off JSON reads as the call itself being malformed.
        tag={block.truncated ? t('activity.session.shortened') : undefined}
        preview={oneLine(block.input)}
        body={block.input}
      />
    )
  }
  if (block.kind === 'tool_result') {
    return (
      <Fold
        icon='ri-corner-down-right-line'
        label={t('activity.session.toolResult')}
        preview={oneLine(block.text)}
        body={block.text}
      />
    )
  }
  if (block.kind === 'raw') {
    return (
      <Fold
        icon='ri-braces-line'
        label={t('activity.session.otherContent')}
        preview={oneLine(block.text)}
        body={block.text}
      />
    )
  }
  // Injected context is folded once per turn by the caller, not per block:
  // a single user turn can carry half a dozen reminders.
  return null
}

function TurnRow({ message }: { message: SessionMessageItem }) {
  const { t } = useTranslation()
  const blocks = normaliseContent(message.content)
  const injected = blocks.filter(isInjected)
  const visible = blocks
    .map((block, position) => ({ block, key: blockKey(message.id, position, block) }))
    .filter(({ block }) => !isInjected(block))
  const isUser = message.role === 'user'
  const role =
    message.role === 'user'
      ? t('activity.session.roleUser')
      : message.role === 'assistant'
        ? t('activity.session.roleAssistant')
        : message.role
  return (
    <div
      className={cn(
        'border-t border-l-2 border-t-border/60 px-6 py-3 transition-colors hover:bg-muted/50',
        isUser ? 'border-l-foreground/30' : 'border-l-transparent'
      )}
    >
      <div className='flex items-baseline gap-2'>
        <span
          className={cn(
            'text-[12px] font-medium uppercase tracking-wider',
            isUser ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          {role}
        </span>
        <span className='ml-auto font-mono text-[12px] tabular-nums text-muted-foreground'>
          {dayjs(message.createdAt).format('HH:mm:ss')}
        </span>
      </div>
      {visible.map(({ block, key }) => (
        <Block key={key} block={block} />
      ))}
      {injected.length === 0 ? null : (
        <Fold
          icon='ri-robot-2-line'
          label={t('activity.session.injected', { n: injected.length })}
          preview={oneLine(injected[0].text.replace(WRAPPER_TAG, ' '))}
          body={injected.map((b) => b.text).join('\n\n')}
        />
      )}
      {blocks.length === 0 ? (
        <p className='mt-1.5 text-xs text-muted-foreground'>{t('activity.session.emptyTurn')}</p>
      ) : null}
    </div>
  )
}

/** Mount with `key={sessionId}` so another session opens on its newest page. */
export function SessionConversation({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  // Whether the archive this tab reads is even being written.
  const { config } = useConfig()
  const captureOff = config !== null && config.CAPTURE_MESSAGES === false
  const fetchPage = useCallback((offset: number) => fetchSessionMessages(sessionId, PAGE_SIZE, offset), [sessionId])
  const { pageIndex, setPageIndex, page, error } = useSessionPage(fetchPage, PAGE_SIZE)

  if (error !== null) return <ScreenMessage tone='bad'>{error}</ScreenMessage>
  if (page === null) return <ScreenMessage>{t('common.loading')}</ScreenMessage>
  if (page.total === 0) {
    return (
      <ScreenMessage>
        {/* An empty tab because capture is switched off looks exactly like
            a session that said nothing. Name the switch and link to it. */}
        {captureOff ? (
          <Trans
            i18nKey='activity.session.messagesOff'
            components={{ settings: <Link to='/settings/logging' className='underline' /> }}
          />
        ) : (
          t('activity.session.noMessages')
        )}
      </ScreenMessage>
    )
  }
  return (
    <>
      {/* Capped like Logs: prose has a natural measure, and the first turn's
          top border would double the tab strip's. */}
      <div className='max-w-[64rem] [&>*:first-child]:border-t-0'>
        {page.items.map((message) => (
          <TurnRow key={message.id} message={message} />
        ))}
      </div>
      <Pager
        page={pageIndex}
        pageSize={PAGE_SIZE}
        loaded={page.items.length}
        total={page.total}
        onPage={setPageIndex}
      />
    </>
  )
}
