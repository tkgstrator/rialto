// Numeric formatters for the Sessions view. Kept dependency-free so they
// can be unit-tested without pulling React or i18n into the harness.

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

// 3 significant digits — Intl handles the leading-zero + comma cases that
// Number#toPrecision botches (small values flip to exponential; big ones
// lose thousand-separators). Trailing zeros are preserved so widths stay
// comparable across rows ($0.00549 lines up with $0.00677).
const COST_FMT = new Intl.NumberFormat('en-US', {
  minimumSignificantDigits: 3,
  maximumSignificantDigits: 3
})

export function fmtCost(usd: number | null): string {
  if (usd == null) return '–'
  if (usd === 0) return '$0'
  if (usd < 0.00001) return '<$0.00001'
  return `$${COST_FMT.format(usd)}`
}

export function fmtMs(ms: number): string {
  if (ms >= 1_000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}
