/**
 * Deterministic PRNG for the demo seed.
 *
 * Seeded rather than Math.random so a re-run produces the same rows: a
 * screenshot or a mock diff taken against the demo data stays comparable
 * across runs, and `--clean` followed by a re-seed does not reshuffle
 * every number on the screen.
 */

export interface Random {
  /** Uniform in [0, 1). */
  next: () => number
  /** Uniform integer in [min, max], inclusive on both ends. */
  int: (min: number, max: number) => number
  /** True with probability `p` (0-1). */
  chance: (p: number) => boolean
  pick: <T>(items: readonly T[]) => T
  /** Pick by relative weight; weights need not sum to anything in particular. */
  weighted: <T>(items: ReadonlyArray<readonly [T, number]>) => T
}

// mulberry32 — 32 bits of state, good enough for fixture data and short
// enough to keep the seed script dependency-free. The state lives in an
// object because the house style bans `let`.
export function createRandom(seed: number): Random {
  const state = { a: seed >>> 0 }
  const next = (): number => {
    state.a = (state.a + 0x6d2b79f5) >>> 0
    const t0 = Math.imul(state.a ^ (state.a >>> 15), 1 | state.a)
    const t1 = (t0 + Math.imul(t0 ^ (t0 >>> 7), 61 | t0)) ^ t0
    return ((t1 ^ (t1 >>> 14)) >>> 0) / 4_294_967_296
  }
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1))
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]
  const weighted = <T>(items: ReadonlyArray<readonly [T, number]>): T => {
    const total = items.reduce((sum, [, weight]) => sum + weight, 0)
    const roll = next() * total
    const hit = items.reduce<{ acc: number; found: T | null }>(
      (state2, [value, weight]) => {
        if (state2.found !== null) return state2
        const acc = state2.acc + weight
        return acc >= roll ? { acc, found: value } : { acc, found: null }
      },
      { acc: 0, found: null }
    )
    return hit.found === null ? items[items.length - 1][0] : hit.found
  }
  return { next, int, chance: (p: number) => next() < p, pick, weighted }
}
