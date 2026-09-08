/**
 * Try a sample request against the rule stack the operator is editing.
 *
 * This is the payoff of giving rules their own screen: first-match-wins
 * ordering is close to impossible to reason about by reading, and the
 * runtime is the only other thing that can answer the question.
 *
 * The rules travel in the request body rather than being read from the
 * saved config, so the answer describes the draft on screen — testing the
 * last save would be the one answer that is never useful. The server walks
 * them with the router's own predicate code over the real token count, so
 * what this panel shows is what the router does.
 */
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pill, RButton } from '@/components/rialto/primitives'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { RouteRule } from '@/schemas/domain/router'
import type { ConditionField, RuleCondition, RuleTestResult, RuleVerdict } from './rules'

const SAMPLE = '{"model": "claude-haiku-4-5", "messages": []}'

const parse = (text: string): { ok: true; body: Record<string, unknown> } | { ok: false } => {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false }
    return { ok: true, body: { ...parsed } }
  } catch {
    return { ok: false }
  }
}

/**
 * What "the request presented nothing" means for each field.
 *
 * A dash would collapse it with "presented a value that did not match",
 * and those are different problems: one is a request that never carried
 * the signal, the other is a rule looking for a different value.
 */
const ABSENT_KEYS: Record<ConditionField, string> = {
  requestedTier: 'routing.rules.tester.absentRequestedTier',
  requestedModel: 'routing.rules.tester.absentRequestedModel',
  thinking: 'routing.rules.tester.absentThinking',
  minTokens: 'routing.rules.tester.absentTokens',
  maxTokens: 'routing.rules.tester.absentTokens',
  hasTool: 'routing.rules.tester.absentHasTool',
  effort: 'routing.rules.tester.absentEffort'
}

function ConditionRow({ condition }: { condition: RuleCondition }) {
  const { t } = useTranslation()
  return (
    <div className='flex items-baseline gap-2 py-0.5 text-[12px]'>
      <i
        className={cn(
          'shrink-0 text-xs',
          condition.matched ? 'ri-check-line text-emerald-600 dark:text-emerald-400' : 'ri-close-line text-destructive'
        )}
      />
      <span className='w-28 shrink-0 truncate font-mono text-muted-foreground'>{condition.field}</span>
      <span className='min-w-0 truncate font-mono'>{condition.expected}</span>
      {condition.actual === null ? (
        <span className='ml-auto shrink-0 text-right text-muted-foreground'>{t(ABSENT_KEYS[condition.field])}</span>
      ) : (
        <span className='ml-auto shrink-0 truncate text-right font-mono text-muted-foreground'>
          {t('routing.rules.tester.got', { actual: condition.actual })}
        </span>
      )}
    </div>
  )
}

/**
 * One rule's verdict. When exactly one condition failed, the header names
 * it — that single field is almost always the answer the operator came for.
 */
function RuleTrace({ verdict, first }: { verdict: RuleVerdict; first: boolean }) {
  const { t } = useTranslation()
  const failed = verdict.conditions.filter((c) => !c.matched)
  const only = failed.length === 1 ? failed[0].field : null
  return (
    <div
      className={cn(
        'border-l-2 px-3 py-2 transition-colors hover:bg-muted/50',
        first ? '' : 'border-t border-t-border/60',
        verdict.matched ? 'border-l-foreground bg-muted/40' : 'border-l-transparent'
      )}
    >
      <div className='flex items-center gap-2 text-[12px]'>
        <span className='font-mono tabular-nums text-muted-foreground'>{verdict.index + 1}</span>
        <span className='truncate'>
          {verdict.name === null ? t('routing.rules.ruleN', { n: verdict.index + 1 }) : verdict.name}
        </span>
        <span
          className={cn(
            'ml-auto shrink-0',
            verdict.matched ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
          )}
        >
          {verdict.matched
            ? t('routing.rules.tester.match')
            : only === null
              ? t('routing.rules.tester.noMatch')
              : t('routing.rules.tester.noMatchField', { field: only })}
        </span>
      </div>
      {verdict.conditions.length === 0 ? (
        <div className='mt-1 text-[12px] text-muted-foreground'>{t('routing.rules.tester.noConditions')}</div>
      ) : (
        <div className='mt-1'>
          {verdict.conditions.map((condition) => (
            <ConditionRow key={condition.field} condition={condition} />
          ))}
        </div>
      )}
    </div>
  )
}

function Trace({ result }: { result: RuleTestResult }) {
  const { t } = useTranslation()
  if (result.evaluated.length === 0) return null
  return (
    <div className='mt-3 overflow-hidden rounded-md border border-border'>
      {result.evaluated.map((verdict, i) => (
        <RuleTrace key={verdict.index} verdict={verdict} first={i === 0} />
      ))}
      {result.notEvaluated === 0 ? null : (
        <div className='border-t border-border/60 px-3 py-2 text-[12px] text-muted-foreground'>
          {t('routing.rules.tester.evaluationStopped')}
        </div>
      )}
    </div>
  )
}

function TokenLine({ count }: { count: number }) {
  const { t } = useTranslation()
  return (
    <div className='mt-2 text-[12px] text-muted-foreground'>
      {t('routing.rules.tester.tokenLine', { count: count.toLocaleString() })}
    </div>
  )
}

/**
 * Nothing matched. Distinct from a rule that matched with no target: here
 * the rule stack had no opinion at all and the scenario catch-all decides.
 */
function NoMatch({ result }: { result: RuleTestResult }) {
  const { t } = useTranslation()
  return (
    <div className='mt-3 rounded-md border border-border px-4 py-3'>
      <Pill tone='mute'>{t('routing.rules.tester.noRuleMatched')}</Pill>
      <div className='mt-2 text-[12px] text-muted-foreground'>
        {t('routing.rules.tester.noneApplied', { n: result.evaluated.length })}
      </div>
      <TokenLine count={result.tokenCount} />
    </div>
  )
}

function Matched({ result }: { result: RuleTestResult }) {
  const { t } = useTranslation()
  const position = (result.matchedIndex === null ? 0 : result.matchedIndex) + 1
  const last = position + result.notEvaluated
  return (
    <div className='mt-3 rounded-md border border-border px-4 py-3'>
      <div className='flex items-center gap-2'>
        <Pill tone='ok'>{t('routing.rules.tester.rulePositionMatched', { n: position })}</Pill>
        <span className='text-[12px] text-muted-foreground'>
          {result.matchedName === null ? t('routing.rules.ruleN', { n: position }) : result.matchedName}
        </span>
      </div>
      <div className='mt-2 flex items-center gap-1.5 font-mono text-[12px]'>
        <span className='text-muted-foreground'>{t('routing.rules.tester.requested')}</span>
        <i className='ri-arrow-right-line text-xs text-muted-foreground/50' />
        {/* A null target on a MATCHED rule is a deliberate "leave this
            traffic alone", not an unfinished rule. */}
        <span>{result.target === null ? t('routing.rules.tester.noRewriteUpstream') : result.target}</span>
      </div>
      {result.notEvaluated === 0 ? null : (
        <div className='mt-1 text-[12px] text-muted-foreground'>
          {result.notEvaluated === 1
            ? t('routing.rules.tester.oneNotEvaluated', { n: last })
            : t('routing.rules.tester.rangeNotEvaluated', { from: position + 1, to: last })}
        </div>
      )}
      <TokenLine count={result.tokenCount} />
    </div>
  )
}

export function RuleTester({ rules }: { rules: readonly RouteRule[] }) {
  const { t } = useTranslation()
  const [text, setText] = useState(SAMPLE)
  const [result, setResult] = useState<RuleTestResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const run = useCallback(() => {
    const parsed = parse(text)
    if (!parsed.ok) {
      setError(t('routing.rules.tester.invalidJson'))
      setResult(null)
      return
    }
    setRunning(true)
    setError(null)
    api
      .post<RuleTestResult>('/routing-rules/test', { rules, request: parsed.body })
      .then(setResult)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setResult(null)
      })
      .finally(() => setRunning(false))
  }, [text, rules, t])

  return (
    <div className='mt-6 border-t border-border px-6 py-5'>
      <div className='flex items-baseline gap-3'>
        <h3 className='text-sm font-semibold'>{t('routing.rules.tester.title')}</h3>
        <span className='text-[12px] text-muted-foreground'>{t('routing.rules.tester.subtitle')}</span>
      </div>
      <div className='mt-3 flex items-center gap-2'>
        <input
          className='flex h-8 flex-1 items-center rounded-md border border-border bg-transparent px-3 font-mono text-xs text-muted-foreground outline-none'
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-label={t('routing.rules.tester.requestBody')}
        />
        <RButton variant='primary' icon='ri-play-line' onClick={run} disabled={running}>
          {t('routing.rules.tester.run')}
        </RButton>
      </div>
      {error === null ? null : <div className='mt-3 text-[12px] text-destructive'>{error}</div>}
      {result === null ? null : (
        <>
          {result.matchedIndex === null ? <NoMatch result={result} /> : <Matched result={result} />}
          <Trace result={result} />
        </>
      )}
    </div>
  )
}
