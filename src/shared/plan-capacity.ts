/**
 * How much budget one subscription seat is worth, relative to the smallest.
 *
 * Quotas scale 1 : 5 : 20 — Claude Pro : Max 5x : Max 20x, and Codex Plus :
 * Pro 5x : Pro 20x, since OpenAI split Pro the way Anthropic split Max.
 * Percentages from two seats are therefore not comparable quantities: a
 * 20x sitting at 0% carries twenty times the headroom a Pro at 0% does.
 * Anything folding several accounts into one number has to weight by
 * this, or it reports a pool of one spent 5x and one untouched 20x as half
 * gone when four fifths of it is still there.
 *
 * Read off both stored strings because neither vendor fills the same one.
 * Claude puts the level in `rate_limit_tier` ("default_claude_max_20x") and
 * only "max" in the plan; Codex names it in `chatgpt_plan_type` itself —
 * `prolite` is the 5x seat, a bare `pro` the 20x one — and leaves the tier
 * empty. An explicit "20x" / "5x" fragment wins wherever it appears.
 *
 * `kind` is needed because "pro" means opposite ends of the range: Claude
 * Pro is the unit, Codex Pro is the top seat. Without the vendor a bare
 * "pro" would have to guess, and both guesses are wrong half the time.
 *
 * Lives in `shared/` because both sides must give the same answer: the
 * routing scheduler weights each account's remaining budget by it, and the
 * Providers screen's Quota column weights the same accounts the same way.
 * Pure arithmetic on three strings — no imports, so the browser can carry
 * it. `plan-label.ts` names the same seats, from the same strings.
 */
export type SeatKind = 'claude' | 'codex' | null

const lower = (value: string | null): string => (value === null ? '' : value.toLowerCase())

export const planCapacityWeight = (kind: SeatKind, plan: string | null, rateLimitTier: string | null): number => {
  const said = `${lower(plan)} ${lower(rateLimitTier)}`
  if (said.includes('20x')) return 20
  if (said.includes('5x')) return 5
  // Claude Max whose tier string never arrived: the 5x seat is the floor
  // of the Max range, so it is the safe reading of an unqualified "max".
  if (said.includes('max')) return 5
  // Checked before `pro`, which it contains.
  if (kind === 'codex' && said.includes('prolite')) return 5
  if (kind === 'codex' && said.includes('pro')) return 20
  return 1
}
