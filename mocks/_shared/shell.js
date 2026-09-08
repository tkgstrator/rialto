/**
 * Shared app chrome for the Rialto UI mocks.
 *
 * Static HTML has no include mechanism, so each mock calls renderShell()
 * and the sidebar / header markup is injected from here. Keeps the five
 * screen mocks focused on their own content and guarantees the chrome is
 * pixel-identical across them — which matters because the ui-mock-diff
 * skill diffs whole pages, chrome included.
 *
 * Deliberately a CLASSIC script exposing one global, not an ES module:
 * the mocks are opened over file:// and Chrome blocks module imports
 * from origin `null`. Everything hangs off `window.Shell`.
 */

;(function (global) {

// ─── Theme ────────────────────────────────────────────────────────────
// Applied at script-parse time, from <head>, before the body paints —
// otherwise every navigation flashes light before switching. The choice
// persists across pages so a reviewer can toggle once on the index and
// walk the whole set in dark.
//
// Load only READS storage; only an explicit toggle writes. That keeps
// the screenshot capture deterministic: shoot.ts opens a fresh context
// per theme (empty storage), this falls back to the context's
// prefers-color-scheme, and shoot.ts then sets the class explicitly.

const THEME_KEY = 'rialto-mock-theme'

// file:// pages are an opaque origin and some browsers throw on any
// storage access there. A mock that cannot remember the theme is fine;
// a mock that throws before rendering is not.
const readStored = () => {
  try {
    return localStorage.getItem(THEME_KEY)
  } catch {
    return null
  }
}

const prefersDark = () => global.matchMedia?.('(prefers-color-scheme: dark)').matches === true

const applyTheme = (theme) => {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.style.colorScheme = theme
}

const currentTheme = () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light')

const toggleTheme = () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  try {
    localStorage.setItem(THEME_KEY, next)
  } catch {
    /* not persisted — the page still switches for this view */
  }
  return next
}

const stored = readStored()
applyTheme(stored === 'dark' || stored === 'light' ? stored : prefersDark() ? 'dark' : 'light')

// ─── Cross-screen navigation ──────────────────────────────────────────
// A mock is only useful for reviewing 導線 if the 導線 can be walked, so
// anything that stands for another screen — a table row, a stat tile, a
// rail entry, a header action — carries `data-nav="<file>.html"` and this
// one delegated listener turns it into a link.
//
// An attribute rather than an <a> wrapper because the elements that most
// need it cannot legally hold one: a <tr>, and the rows that already
// contain their own toggle or ⋯ button. A click that landed on such a
// nested control belongs to that control — the row is only followed when
// the click was on the row itself.

const navHrefFor = (event) => {
  const host = event.target.closest?.('[data-nav]')
  if (!host) return null
  const control = event.target.closest('button, a, input, select, textarea')
  if (control && control !== host && host.contains(control)) return null
  return host.getAttribute('data-nav')
}

document.addEventListener('click', (event) => {
  const href = navHrefFor(event)
  if (href) global.location.assign(href)
})

/** Marks an element as a link to another mock. Pairs with the listener above. */
const navTo = (href) => `data-nav="${href}"`

const NAV = [
  { id: 'overview', label: 'Overview', icon: 'ri-dashboard-3-line', href: 'overview.html' },
  { id: 'routing', label: 'Routing', icon: 'ri-git-branch-line', href: 'routing.html' },
  { id: 'providers', label: 'Providers', icon: 'ri-plug-line', href: 'providers.html' },
  // Next to Providers because it is the same question pointed the other
  // way: Providers is outbound (who Rialto sends to), this is inbound
  // (who may send to Rialto). It lived under Settings, where a list with
  // per-token spend, rotation and revocation does not belong — that is
  // operations, not configuration. Settings -> Access keeps the half
  // that really is configuration: who may administer the install.
  { id: 'access-tokens', label: 'Access tokens', icon: 'ri-key-2-line', href: 'access-tokens.html' },
  { id: 'activity', label: 'Activity', icon: 'ri-pulse-line', href: 'activity.html' },
  { id: 'settings', label: 'Settings', icon: 'ri-settings-3-line', href: 'settings.html' }
]

const navItem = (item, active, disclosure = '') => {
  const on = item.id === active
  const state = on
    ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
    : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
  const chevron =
    disclosure === ''
      ? ''
      : `<i class="ri-arrow-${disclosure === 'open' ? 'down' : 'right'}-s-line ml-auto text-sm leading-none text-muted-foreground"></i>`
  return `
    <a href="${item.href}" class="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors ${state}">
      <i class="${item.icon} text-base leading-none opacity-80"></i>
      <span>${item.label}</span>
      ${chevron}
    </a>`
}

/**
 * Child row of an expanded section. Indented and icon-less on purpose: the
 * icon column belongs to the five sections, and repeating icons a level
 * down makes the two levels read as one flat list.
 *
 * Same `text-sm` as its parent, which is how Cloudflare's own sidebar does
 * it — the level is carried by the indent (pl-9 lands the label exactly
 * under the parent's, past its icon) and by weight when active. Shrinking
 * the type as well says "less important" about the row you are actually
 * on, and it is the row you read most.
 */
const subNavItem = (item, active) => {
  const on = item.id === active
  const state = on
    ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
    : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
  // No counts here. A menu answers "where can I go", not "how much is in
  // there" — and the numbers move on every request, so a sidebar carrying
  // them ticks in the corner of the eye while you are reading something
  // else. They still show where the data is: the Activity header says
  // "128 sessions · 18.7k requests", and the tab strips keep theirs.
  return `
    <a href="${item.href}" class="flex items-center gap-2 rounded-md py-1.5 pl-[9px] pr-2.5 text-sm transition-colors ${state}">
      <span>${item.label}</span>
    </a>`
}

/**
 * The children of one expanded section, behind a vertical guide.
 *
 * The line sits at 18px — dead centre of the parent's icon. The 8px after
 * it belongs to the group, not to the rows: it keeps the hover and active
 * backgrounds off the line, which otherwise reads as one thick rule with a
 * bite taken out of it. The rows then pad 9px more, so a child's label
 * lands at the same x as its parent's (8 nav padding + 10 + 16 icon + 10
 * gap = 44, and 18 + 1 + 8 + 9 = 36 + the same 8 = 44).
 *
 * Without the guide a long expanded tree loses track of which parent it
 * belongs to as soon as the next section scrolls into view; with it, the
 * indent is a claim the eye can follow instead of one it has to measure.
 */
const subNavGroup = (kids, sub) => `
  <div class="ml-[18px] flex flex-col gap-0.5 border-l border-sidebar-border pl-2">
    ${kids.map((c) => subNavItem(c, sub)).join('')}
  </div>`

/**
 * Header breadcrumb.
 *
 * Every screen but Overview sits under one of the five sections, and three
 * of them nest a level further — a provider, a settings section, one
 * session. A bare title could not say which: "Access", "Requests" and
 * "Presets" all read as top-level screens when they are not, and the
 * titles had already drifted into saying different things at different
 * depths ("Activity" on one Activity screen, "Logs" on the next).
 *
 * The section crumb is DERIVED from `active` rather than passed. It is the
 * same fact as the highlighted sidebar item, so deriving it means the two
 * cannot disagree; a screen only names what sits below the section.
 *
 * A crumb given as a string is the page you are on (plain text); an object
 * `{ label, href }` is an ancestor, and every ancestor is a link back up.
 */
const crumbTrail = (active, rest) => {
  const section = NAV.find((n) => n.id === active)
  const trail = [
    { label: section.label, href: section.href },
    ...rest.map((c) => (typeof c === 'string' ? { label: c } : c))
  ]
  return trail
    .map((c, i) => {
      const sep = i === 0 ? '' : '<span class="px-1.5 font-normal text-muted-foreground/40">/</span>'
      const body =
        i === trail.length - 1
          ? c.label
          : `<a href="${c.href}" class="font-normal text-muted-foreground transition-colors hover:text-foreground">${c.label}</a>`
      return sep + body
    })
    .join('')
}

/**
 * @param {{ active: string, crumbs?: (string | {label: string, href: string})[],
 *           subtitle?: string, actions?: string,
 *           navMode?: 'flat' | 'accordion' | 'drilldown' | 'tree', sub?: string }} opts
 */
function renderShell(opts) {
  const root = document.getElementById('root')
  const content = root.innerHTML
  root.innerHTML = `
<div class="flex h-screen w-full overflow-hidden bg-background text-foreground">

  ${opts.navMode === 'collapsed' ? collapsedAside(opts) : expandedAside(opts)}

  <div class="flex min-w-0 flex-1 flex-col">
    <header class="flex h-14 shrink-0 items-center gap-4 border-b border-border px-6">
      <div class="min-w-0">
        <h1 class="truncate text-sm font-semibold tracking-tight">${crumbTrail(opts.active, opts.crumbs ?? [])}</h1>
        ${opts.subtitle ? `<p class="truncate text-xs text-muted-foreground">${opts.subtitle}</p>` : ''}
      </div>
      <div class="ml-auto flex items-center gap-2">${opts.actions ?? ''}</div>
    </header>
    <main class="min-h-0 flex-1 overflow-y-auto">${content}</main>
  </div>
  ${opts.toast ?? ''}

</div>`

  const label = document.getElementById('mock-theme-label')
  const paintLabel = () => {
    if (label) label.textContent = currentTheme()
  }
  paintLabel()
  document.getElementById('mock-theme-toggle')?.addEventListener('click', () => {
    toggleTheme()
    paintLabel()
  })
}

// ─── Shared building blocks ───────────────────────────────────────────
// Exported as strings so each mock composes the same primitives rather
// than re-inventing spacing / border treatments per page.

/** Flat row treatment used everywhere instead of shadcn Card. */
const ROW = 'border-l-2 border-l-transparent px-4 py-3 transition-colors hover:bg-muted/50'

/** Section container: a titled block with a hairline top rule. */
const section = (title, body, meta = '') => `
  <section class="border-t border-border first:border-t-0">
    <div class="flex items-baseline gap-3 px-6 pt-6 pb-3">
      <h2 class="text-sm font-semibold">${title}</h2>
      ${meta ? `<span class="text-xs text-muted-foreground/70">${meta}</span>` : ''}
    </div>
    ${body}
  </section>`

/**
 * Modal over the screen, mirroring `components/ui/dialog.tsx`.
 *
 * Every class here is copied from DialogOverlay / DialogContent /
 * DialogHeader so the mock and the shadcn dialog it stands for cannot
 * drift: a `bg-black/10` backdrop-blurred overlay, and a `sm:max-w-md`
 * popover panel with `rounded-xl`, `p-6`, `gap-6`, a ring rather than a
 * border, and the ghost `icon-sm` close button at `top-4 right-4`.
 *
 * `fixed`, not `absolute`, because the real one portals to the body: the
 * overlay covers the sidebar too. Asking a question over the whole app is
 * the point — it is what says the rest of the screen is not what you are
 * answering right now.
 *
 * A dialog is right when the task is discrete, cancellable, and decided
 * against what is already on screen. Naming a token is exactly that:
 * "MacBook — Claude Code" being taken is the thing you need to see while
 * typing, and an inline form pushed the list that says so off the page.
 */
const dialog = (title, body, footer = '') => `
  <div class="fixed inset-0 isolate z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs"></div>
  <div class="fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100vh-4rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-6 overflow-y-auto rounded-xl bg-popover p-6 text-sm text-popover-foreground ring-1 ring-foreground/10 sm:max-w-md">
    <div class="flex flex-col gap-2">
      <h2 class="font-heading text-sm font-medium leading-none">${title}</h2>
    </div>
    ${body}
    ${footer ? `<div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">${footer}</div>` : ''}
    <button class="absolute top-4 right-4 inline-flex size-8 shrink-0 items-center justify-center rounded-[min(var(--radius-md),10px)] border border-transparent text-sm transition-all hover:bg-muted hover:text-foreground">
      <i class="ri-close-line text-base leading-none"></i>
    </button>
  </div>`

/** Small status pill. tone: ok | warn | bad | mute | info */
const pill = (text, tone = 'mute') => {
  const tones = {
    ok: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    warn: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    bad: 'bg-destructive/10 text-destructive',
    info: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
    mute: 'bg-muted text-muted-foreground'
  }
  return `<span class="inline-flex items-center rounded px-1.5 py-0.5 text-[12px] font-medium ${tones[tone]}">${text}</span>`
}

/**
 * Toast, as sonner actually renders it: bottom-right, popover ground, one
 * line with a status icon, 356px wide.
 *
 * The implementation makes 61 toast calls across 20 components — every
 * save, every failure, every copied token lands here — and not one mock
 * showed one, so the tone and wording of the app's whole feedback channel
 * was being decided by default. Set `toast` on renderShell to draw one.
 */
const TOAST_ICON = {
  ok: 'ri-checkbox-circle-line text-emerald-600 dark:text-emerald-400',
  bad: 'ri-close-circle-line text-destructive',
  warn: 'ri-error-warning-line text-amber-600 dark:text-amber-400',
  info: 'ri-information-line text-sky-600 dark:text-sky-400'
}

const toast = (text, tone = 'ok', detail = '') => `
  <div class="pointer-events-none fixed bottom-4 right-4 z-30 w-[356px]">
    <div class="flex items-start gap-2.5 rounded-md border border-border bg-popover px-4 py-3 text-popover-foreground shadow-lg">
      <i class="${TOAST_ICON[tone]} mt-px text-base leading-none"></i>
      <div class="min-w-0 flex-1">
        <div class="text-xs font-medium">${text}</div>
        ${detail ? `<div class="mt-0.5 text-[12px] leading-snug text-muted-foreground">${detail}</div>` : ''}
      </div>
    </div>
  </div>`

/** Inline monospace token — model ids, paths, keys. */
const mono = (text) => `<span class="font-mono text-[12px] text-muted-foreground">${text}</span>`

/**
 * The four inbound surfaces, named by the raw endpoint a client actually
 * calls. Deliberately NOT short slugs (`messages`, `chat`, …): the path is
 * the string the operator already typed into ANTHROPIC_BASE_URL or the
 * OpenAI SDK, so it needs no glossary and cannot be confused with a
 * scenario name.
 */
const SURFACES = [
  { path: '/v1/messages', client: 'Claude Code' },
  { path: '/v1/chat/completions', client: 'OpenAI SDK' },
  { path: '/v1/responses', client: 'Codex CLI' },
  { path: '/v1beta/models/*', client: 'Gemini CLI' }
]

/** Surface label for a table cell. Monospace so paths align down a column. */
const surfacePill = (path) =>
  `<span class="inline-flex items-center rounded bg-muted px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground">${path}</span>`

/** Toggle chip for "which surfaces does this apply to" pickers. */
const surfaceChip = (path, on) => `
  <button class="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[12px] transition-colors ${
    on ? 'border-foreground/40 bg-muted/60 text-foreground' : 'border-border text-muted-foreground hover:bg-muted/50'
  }">
    ${on ? '<i class="ri-check-line text-xs"></i>' : ''}${path}
  </button>`

// ─── Access tokens ────────────────────────────────────────────────────
// Shared because three screens draw this same list: the list itself, and
// the two states of issuing, both of which keep the table on screen
// behind a dialog. Three copies of a table is three chances for them to
// disagree about what a token row says.

/**
 * Only the sha256 is stored; `prefix` is a separate column purely so a
 * row is identifiable in the list. The plaintext is shown once, at
 * creation, and never again.
 *
 * Endpoint is the interesting column: scoping a token to the inbound
 * surfaces it may call turns "issue another key" into per-client routing,
 * without inventing a second config axis.
 *
 * Cost and Expires rather than Scope and Created. Scope was a `proxy`
 * pill on every row — a column that can only say one thing. Created is
 * not a decision; Expires is, and Cost 30d is the number an operator
 * opens this screen for.
 */
const ACCESS_TOKENS = [
  { name: 'MacBook — Claude Code', prefix: 'rialto_a91f4c', surfaces: ['/v1/messages'], used: '2m ago', reqs: '12.4k', cost: '$41.2', expires: 'never' },
  // Two surfaces on one row. Codex speaks /v1/responses and
  // /v1/chat/completions, so a single-surface pin could only be expressed
  // by giving it no scope at all.
  { name: 'MacBook — Codex', prefix: 'rialto_7c02b8', surfaces: ['/v1/responses', '/v1/chat/completions'], used: '19m ago', reqs: '2.71k', cost: '$18.6', expires: 'never' },
  { name: 'Gemini CLI', prefix: 'rialto_be44d1', surfaces: ['/v1beta/models/*'], used: '1h ago', reqs: '486', cost: '–', expires: '2026-12-01' },
  { name: 'CI — nightly evals', prefix: 'rialto_0d18e9', surfaces: [], used: '6h ago', reqs: '3.10k', cost: '$9.14', expires: '2026-10-08' },
  { name: 'Old laptop', prefix: 'rialto_2b9047', surfaces: ['/v1/messages'], used: '41d ago', reqs: '88.1k', cost: '–', expires: 'never', revoked: true }
]

/**
 * The endpoint cell.
 *
 * One pill and a count, not every path: the column is 12rem and four
 * paths would take the row to two lines. The whole list is a hover away.
 */
const tokenScopeCell = (paths) => {
  if (paths.length === 0) return '<span class="text-[12px] text-muted-foreground/50">all</span>'
  const rest = paths.length - 1
  return `<span class="inline-flex items-center gap-1" title="${paths.join(' · ')}">${surfacePill(paths[0])}${
    rest > 0 ? `<span class="shrink-0 font-mono text-[12px] text-muted-foreground/70">+${rest}</span>` : ''
  }</span>`
}

/**
 * One token row. The requests and last-used columns are decision support
 * for Revoke; the full picture behind them is Activity → Usage, which
 * breaks spend down by exactly these rows.
 *
 * The row leads to the token's own page. Rotate and Revoke live there and
 * nowhere else — as row actions they sat one mis-aimed click from every
 * row of a table of live credentials, and the cost of that click is a CLI
 * failing with a 401 nobody can trace from the client end. Profile is off
 * this table for the same reason it is not a column here: it is a routing
 * detail, and the row exists to say which credentials are live and what
 * they cost.
 */
const tokenRow = (t) => `
  <tr ${navTo('access-token.html')} class="cursor-pointer border-t border-border/60 transition-colors hover:bg-muted/50 ${t.revoked ? 'opacity-45' : ''}">
    <td class="py-2.5 pl-6 pr-3">
      <div class="flex items-center gap-2">
        <span class="text-xs font-medium">${t.name}</span>
        ${t.revoked ? pill('revoked', 'bad') : ''}
      </div>
      <div class="font-mono text-[12px] text-muted-foreground">${t.prefix}</div>
    </td>
    <td class="px-3">${tokenScopeCell(t.surfaces)}</td>
    <td class="px-3 text-right font-mono text-xs tabular-nums">${t.reqs}</td>
    <td class="px-3 text-right font-mono text-xs tabular-nums">${t.cost}</td>
    <td class="px-3 text-right font-mono text-[12px] tabular-nums text-muted-foreground">${t.used}</td>
    <td class="px-3 text-right font-mono text-[12px] tabular-nums text-muted-foreground">${t.expires}</td>
    <td class="py-2.5 pl-3 pr-6">
      <div class="flex justify-end text-muted-foreground/50"><i class="ri-arrow-right-s-line text-base"></i></div>
    </td>
  </tr>`

/** The live tokens, as the list screen and both issuing states draw them. */
const tokenTable = () => `
  <table class="w-full table-fixed">
    <colgroup><col><col class="w-48"><col class="w-20"><col class="w-28"><col class="w-28"><col class="w-24"><col class="w-10"></colgroup>
    <thead>
      <tr class="text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:whitespace-nowrap [&>th]:align-bottom [&>th]:pb-2">
        ${sortTh('Token', 'pl-6 pr-3')}
        ${sortTh('Endpoint', 'px-3')}
        ${sortTh('Requests', 'px-3', 'right')}
        ${sortTh('Cost 30d', 'px-3', 'right')}
        ${sortTh('Last used', 'px-3', 'right', true, 'desc')}
        ${sortTh('Expires', 'px-3', 'right')}
        <th class="pl-3 pr-6"></th>
      </tr>
    </thead>
    <tbody>${ACCESS_TOKENS.filter((t) => !t.revoked).map(tokenRow).join('')}</tbody>
  </table>`

/**
 * Tier cell for the model tables — editable, not a label.
 *
 * Tier is per-model (`Model.manualTier`) and the router reads
 * `manualTier ?? tierOf(name)`. `tierOf` only recognises the four Claude
 * families as substrings, so `gpt-5.5`, `gemini-3.1-pro` and even
 * `claude-mythos-5` classify as nothing until someone says what they are —
 * and Routing's "tier respect" constraint cannot hold a floor it cannot
 * measure. The override exists in the schema and the PATCH endpoint takes
 * it; there has never been a control for it, which is why this is a
 * three-state cell rather than the pill it used to be.
 *
 *   manual  an operator set it        — solid, foreground
 *   auto    inferred from the name    — muted, no ground
 *   unset   neither; router sees none — faint dash
 */
const CELL_TONE = {
  manual: 'bg-muted text-foreground',
  auto: 'text-muted-foreground',
  unset: 'text-muted-foreground/50'
}

/** Inline editable table cell: the value, plus a disclosure chevron. */
const selectCell = (label, source) => `
  <button class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] transition-colors hover:bg-muted/60 ${CELL_TONE[source]}">
    ${label}<i class="ri-arrow-down-s-line text-xs opacity-60"></i>
  </button>`

const tierCell = (tier, source) => selectCell(source === 'unset' ? '—' : tier, source)

/**
 * Per-model reasoning effort (`Model.reasoningEffort`).
 *
 * The same shape of hole as the tier was: the column exists, the PATCH
 * endpoint takes it and `api.setModelReasoningEffort()` is written — with
 * no caller anywhere. Null means "send nothing and let the vendor pick",
 * which is why unset is a dash rather than `medium`: writing the vendor's
 * default into the request is not the same as staying out of the way.
 * Only OpenAI / Responses / Codex models read it, so it is an api_key
 * concern and does not appear on the subscription table.
 */
const effortCell = (effort) => selectCell(effort === null ? '—' : effort, effort === null ? 'unset' : 'manual')

/** Horizontal utilization meter. pct 0-100. */
const meter = (pct, tone = 'auto') => {
  const resolved = tone === 'auto' ? (pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'ok') : tone
  const bar = { ok: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-destructive' }[resolved]
  return `
    <div class="h-1 w-full overflow-hidden rounded-full bg-muted">
      <div class="h-full rounded-full ${bar}" style="width:${pct}%"></div>
    </div>`
}

/**
 * Underlined tab strip. Used by every screen that has sub-views, so the
 * treatment stays identical across Routing / Providers / Activity /
 * Settings instead of each page inventing its own.
 * items: [{ id, label, count?, href? }]
 */
const tabs = (items, activeId) =>
  items
    .map((t) => {
      const on = t.id === activeId
      const cls = on
        ? 'border-b-foreground font-medium'
        : 'border-b-transparent text-muted-foreground hover:text-foreground'
      const count =
        t.count === undefined || t.count === ''
          ? ''
          : `<span class="font-mono text-[12px] tabular-nums text-muted-foreground">${t.count}</span>`
      const tag = t.href ? 'a' : 'button'
      const href = t.href ? ` href="${t.href}"` : ''
      return `<${tag}${href} class="flex items-center gap-2 border-b-2 px-3 py-3 text-xs transition-colors ${cls}">${t.label}${count}</${tag}>`
    })
    .join('')

/**
 * Sortable column header, emitted as the whole `<th>`.
 *
 * Every table the implementation ships — sessions, requests, models,
 * tokens — sorts, and none of the mocks said so. Mirrors `SortTh`: the
 * caret holds its space while inactive so the header row does not jog
 * sideways as columns are cycled, and on a right-aligned column it leads
 * rather than trails, because trailing it pushes the label inward while
 * the cells below stay flush — which reads as the header being misaligned
 * with its own column.
 */
const sortTh = (label, cls, align = 'left', active = false, dir = 'desc') => {
  const justify = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start'
  const caret = `<i class="text-[11px] ${
    active ? (dir === 'asc' ? 'ri-arrow-up-s-fill' : 'ri-arrow-down-s-fill') : 'ri-arrow-up-s-fill opacity-0'
  }"></i>`
  return `<th class="${cls} text-${align}"><button class="inline-flex w-full items-center gap-1 font-medium uppercase tracking-wider transition-colors hover:text-foreground ${justify} ${
    active ? 'text-foreground' : ''
  }">${align === 'right' ? caret : ''}${label}${align === 'right' ? '' : caret}</button></th>`
}

/** Left rail item (Settings sections, Providers list). */
const railItem = (item, activeId) => {
  const on = item.id === activeId
  const cls = on
    ? 'border-l-foreground bg-muted/60 font-medium'
    : 'border-l-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground'
  const href = item.href ? ` href="${item.href}"` : ''
  return `<a${href} class="flex items-center gap-2.5 border-l-2 px-4 py-2 text-xs transition-colors ${cls}"><i class="${item.icon} text-sm leading-none opacity-80"></i>${item.label}</a>`
}

/** Settings section rail — shared by every settings-* mock. */
const SETTINGS_RAIL = [
  { id: 'server', label: 'Server', icon: 'ri-server-line', href: 'settings.html' },
  { id: 'auth', label: 'Access', icon: 'ri-key-2-line', href: 'settings-access.html' },
  { id: 'logging', label: 'Logging', icon: 'ri-file-list-2-line', href: 'settings-logging.html' },
  { id: 'personas', label: 'Personas', icon: 'ri-user-voice-line', href: 'settings-personas.html' },
  { id: 'statusline', label: 'Status line', icon: 'ri-layout-bottom-line', href: 'settings-statusline.html' },
  { id: 'advanced', label: 'Advanced', icon: 'ri-terminal-box-line', href: 'settings-advanced.html' }
]

/**
 * Button. `href` renders the same box as an <a> instead of a <button> —
 * an action that names another screen ("Live map", "Add provider",
 * "Manage tokens") should reach it, and only the tag changes, so the two
 * forms are pixel-identical.
 */
/**
 * What sits one level under each of the five sections.
 *
 * Today these live in three different places — a 13rem rail (Settings), a
 * tab strip (Routing, Activity) and nowhere at all (Providers, whose list
 * is data rather than navigation). The registry exists so the three
 * sidebar proposals below can render the same tree without each one
 * re-declaring it.
 *
 * Routing is absent on purpose: the chain IS that screen now that it is
 * the default selector, and Map and Rules are the views around it,
 * reached from the chain's own header.
 */
const SUBNAV = {
  // Two lists, not two screens' worth of settings: a subscription and an
  // API key are configured, read and worried about differently — one has
  // accounts, plans and a quota that runs out, the other has a secret and
  // a price list — and the columns that answer "is this one healthy"
  // share almost nothing. They were one screen behind an 18rem rail that
  // grouped them under two headings anyway; this is that rail, in the
  // sidebar, where the app already keeps its second level. Removing it
  // gives the detail pane back 288px, which is what the model table and
  // the account rows were short of.
  providers: [
    { id: 'subscriptions', label: 'Subscriptions', icon: 'ri-shield-user-line', href: 'providers.html' },
    { id: 'api-keys', label: 'API keys', icon: 'ri-key-line', href: 'providers-keys.html' }
  ],
  activity: [
    { id: 'sessions', label: 'Sessions', icon: 'ri-chat-1-line', href: 'activity.html' },
    { id: 'requests', label: 'Requests', icon: 'ri-exchange-line', href: 'activity-requests.html' },
    { id: 'usage', label: 'Usage', icon: 'ri-battery-2-line', href: 'activity-usage.html' },
    { id: 'logs', label: 'Logs', icon: 'ri-file-list-2-line', href: 'activity-logs.html' }
  ],
  settings: SETTINGS_RAIL
}

/**
 * Sidebar body. `navMode` picks between the shipped design and the three
 * proposals for the two-vertical-menus problem — Settings currently spends
 * 27rem on navigation before any content starts.
 *
 *   flat       what the mocks ship: five sections, sub-views live in a
 *              second column (Settings) or a tab strip (Routing, Activity)
 *   accordion  the active section expands in place; Settings loses its
 *              rail, Routing and Activity keep their tabs
 *   drilldown  the sidebar is REPLACED by the section's own items, with a
 *              way back up
 *   tree       accordion applied everywhere, so the tab strips go too and
 *              the sidebar is the only navigation in the app
 *   cloudflare tree, plus the two things that make Cloudflare's own deep
 *              sidebar work: a search field above it, and several groups
 *              open at once rather than only the current one
 *
 * `sub` names the current child; `active` still names the section, so the
 * breadcrumb and the highlighted rows agree in every mode.
 */
const EXPANDABLE = {
  flat: [],
  accordion: ['settings'],
  drilldown: [],
  tree: ['providers', 'activity', 'settings'],
  cloudflare: ['providers', 'activity', 'settings']
}

/**
 * Search field at the top of the sidebar — the Cloudflare proposal's other
 * half. Once every sub-view is a row in one tree, the tree is long enough
 * that typing beats hunting, and it is the same affordance that makes
 * their deep sidebar usable.
 */
const navSearch = `
  <div class="px-2 pb-2">
    <div class="flex h-9 items-center gap-2 rounded-md border border-sidebar-border px-2.5 text-sm text-muted-foreground">
      <i class="ri-search-line text-base leading-none"></i>
      <span>Search…</span>
      <span class="ml-auto font-mono text-[12px] opacity-60">⌘K</span>
    </div>
  </div>`

const navBody = (mode, active, sub, alsoOpen = []) => {
  const children = SUBNAV[active] ?? []
  if (mode === 'drilldown') {
    const section = NAV.find((n) => n.id === active)
    return `
      <a href="overview.html" class="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground">
        <i class="ri-arrow-left-line text-sm leading-none"></i>All sections
      </a>
      <div class="flex items-center gap-2.5 px-2.5 pt-3 pb-1">
        <i class="${section.icon} text-base leading-none opacity-80"></i>
        <span class="text-sm font-semibold tracking-tight">${section.label}</span>
      </div>
      ${children.map((c) => navItem(c, sub)).join('')}`
  }
  const expandable = EXPANDABLE[mode] ?? []
  // Cloudflare's sidebar lets several groups stand open at once — the one
  // you are in, plus whatever you left open on the way. `alsoOpen` is how
  // a static mock shows that; everywhere else only the current section is.
  const rows = NAV.map((item) => {
    const kids = SUBNAV[item.id] ?? []
    const expands = kids.length > 0 && expandable.includes(item.id)
    const open = expands && (item.id === active || alsoOpen.includes(item.id))
    return (
      navItem(item, active, expands ? (open ? 'open' : 'closed') : '') +
      (open ? subNavGroup(kids, sub) : '')
    )
  }).join('')
  return mode === 'cloudflare' ? navSearch + rows : rows
}

/**
 * Collapsed rail row: one section, one 36px square, no label.
 *
 * `w-14` is the narrowest column that still centres a 16px icon inside
 * the same 36px hit target the expanded rows use, so folding the sidebar
 * changes what a row says and not how big it is.
 */
const railRow = (item, active, hasKids) => {
  const on = item.id === active
  const state = on
    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
    : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
  return `
    <a href="${item.href}" class="relative flex h-9 items-center justify-center rounded-md transition-colors ${state}">
      <i class="${item.icon} text-base leading-none opacity-80"></i>
      ${
        hasKids
          ? // A section with a second level says so, or the rail looks like
            // five destinations and the six Settings screens look deleted.
            // 3px of chevron at the edge of the square is the smallest mark
            // that reads as "there is more this way" without becoming a
            // glyph competing with the icon.
            '<i class="ri-arrow-right-s-line absolute right-0 text-[10px] leading-none text-muted-foreground/70"></i>'
          : ''
      }
    </a>`
}

/**
 * The second level of a collapsed section, as a flyout beside the rail.
 *
 * Collapsing must not delete destinations. Below 1024px the sidebar folds
 * itself, so on a phone Activity's four views and Settings' six sections
 * were reachable only through the command palette — a keyboard affordance
 * on a device with no keyboard, and the sidebar is the app's ONLY
 * navigation now that the tab strips are gone.
 *
 * It is the same rows the expanded tree draws, in the same colours, on the
 * same surface: the rail is the sidebar folded, not a second menu with its
 * own manners. The section keeps the first row because the icon can no
 * longer both open the panel and be the way into the section itself.
 */
const railFlyout = (item, sub) => {
  const kids = SUBNAV[item.id] ?? []
  return `
    <div class="absolute top-0 left-full z-50 ml-1 w-52 rounded-lg border border-sidebar-border bg-sidebar p-1 shadow-lg">
      <a href="${item.href}" class="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors hover:bg-sidebar-accent/60">
        <i class="${item.icon} text-base leading-none opacity-80"></i>
        <span>${item.label}</span>
      </a>
      <div class="my-1 border-t border-sidebar-border"></div>
      ${kids.map((c) => subNavItem(c, sub)).join('')}
    </div>`
}

/** The five sections at rail width, with one flyout drawn open. */
const railBody = (active, sub, flyout) =>
  NAV.map((item) => {
    const kids = SUBNAV[item.id] ?? []
    const body = railRow(item, active, kids.length > 0) + (flyout === item.id ? railFlyout(item, sub) : '')
    return `<div class="relative">${body}</div>`
  }).join('')

/** Footer row at rail width: the icon column and nothing else. */
const railFooterRow = (inner) => `
  <div class="flex w-full items-center justify-center rounded-md py-1.5 text-sm transition-colors hover:bg-sidebar-accent/60">${inner}</div>`

/**
 * The sidebar folded to its icons.
 *
 * `flyout` names the section whose panel is drawn open — a static mock's
 * way of showing what hover, focus and a tap all open in the app.
 */
const collapsedAside = (opts) => `
  <aside class="flex w-14 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
    <div class="flex h-14 items-center justify-center border-b border-sidebar-border">
      <button class="flex size-9 items-center justify-center rounded-md transition-colors hover:bg-sidebar-accent/60">
        <span class="flex size-6 items-center justify-center rounded bg-foreground text-background">
          <i class="ri-route-line text-sm leading-none"></i>
        </span>
      </button>
    </div>
    <nav class="flex flex-1 flex-col gap-0.5 p-2">
      <div class="pb-2">
        <button class="flex h-9 w-full items-center justify-center rounded-md border border-sidebar-border text-muted-foreground transition-colors hover:bg-sidebar-accent/60">
          <i class="ri-search-line text-base leading-none"></i>
        </button>
      </div>
      ${railBody(opts.active, opts.sub, opts.flyout)}
    </nav>
    <div class="border-t border-sidebar-border p-2">
      ${railFooterRow('<span class="flex w-4 shrink-0 items-center justify-center"><span class="size-1.5 rounded-full bg-emerald-500"></span></span>')}
      ${railFooterRow('<i class="ri-shield-check-line w-4 shrink-0 text-base leading-none text-emerald-500"></i>')}
      ${railFooterRow('<i class="ri-contrast-2-line w-4 shrink-0 text-base leading-none text-sidebar-foreground/70 opacity-80"></i>')}
    </div>
  </aside>`

/** The sidebar at full width — what every screen mock but nav-collapsed draws. */
const expandedAside = (opts) => `
  <aside class="flex ${opts.navMode === 'cloudflare' ? 'w-64' : 'w-56'} shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
    <div class="flex h-14 items-center gap-2 border-b border-sidebar-border px-4">
      <div class="flex size-6 items-center justify-center rounded bg-foreground text-background">
        <i class="ri-route-line text-sm leading-none"></i>
      </div>
      <span class="text-sm font-semibold tracking-tight">Rialto</span>
      <span class="ml-auto font-mono text-[12px] text-muted-foreground">v3.0.0</span>
    </div>

    <nav class="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
      ${navBody(opts.navMode ?? 'flat', opts.active, opts.sub, opts.alsoOpen ?? [])}
    </nav>

    <!-- Same row geometry as the nav above: 16px icon slot, gap-2.5,
         px-2.5 py-1.5, 14px label. These three rows had grown three
         different indents (a 6px dot, a 14px icon and a 16px icon, with
         two different gaps), so the labels started at 24 / 34 / 36px
         while the nav started at 44. The status dot now sits centred in
         the same 16px slot the icons use, which is the only way a dot and
         a glyph can share a column. -->
    <div class="border-t border-sidebar-border p-2">
      <div ${navTo('settings.html')} class="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-sidebar-accent/60">
        <span class="flex w-4 shrink-0 items-center justify-center">
          <span class="size-1.5 rounded-full bg-emerald-500"></span>
        </span>
        <span class="text-sidebar-foreground/70">Serving</span>
        <span class="ml-auto font-mono text-[12px] text-muted-foreground">:3456</span>
      </div>
      <div ${navTo('settings-access.html')} class="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-sidebar-accent/60">
        <i class="ri-shield-check-line w-4 shrink-0 text-base leading-none text-emerald-500"></i>
        <span class="truncate text-sidebar-foreground/70">tkgstrator@…</span>
        <span class="ml-auto shrink-0 font-mono text-[12px] text-muted-foreground">Access</span>
      </div>
      <button id="mock-theme-toggle" class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60">
        <i class="ri-contrast-2-line w-4 shrink-0 text-base leading-none opacity-80"></i>
        <span>Theme</span>
        <span id="mock-theme-label" class="ml-auto font-mono text-[12px] text-muted-foreground"></span>
      </button>
    </div>
  </aside>`

const btn = (label, variant = 'ghost', icon = '', href = '') => {
  const variants = {
    primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
    outline: 'border border-border hover:bg-muted/60',
    ghost: 'hover:bg-muted/60 text-muted-foreground hover:text-foreground',
    // Outlined rather than filled: a solid red button is the loudest
    // thing on any screen it lands on, and Revoke sits beside actions
    // reached for far more often.
    danger: 'border border-destructive/30 text-destructive hover:border-destructive/50 hover:bg-destructive/10'
  }
  const cls = `inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors ${variants[variant]}`
  const body = `${icon ? `<i class="${icon} text-sm leading-none"></i>` : ''}${label}`
  return href ? `<a href="${href}" class="${cls}">${body}</a>` : `<button class="${cls}">${body}</button>`
}

// ─── Sub-view strips, shared so they cannot disagree ──────────────────
// Each of these lists lived inline in every screen of its group, which is
// how Activity ended up with a Usage tab on one screen and a three-tab
// strip on the other three. One definition per group; the caller only
// says which entry is current.

/** Activity: Sessions / Requests / Usage / Logs. */
const activityTabs = (active) =>
  tabs(
    [
      { id: 'sessions', label: 'Sessions', count: '128', href: 'activity.html' },
      { id: 'requests', label: 'Requests', count: '18.7k', href: 'activity-requests.html' },
      { id: 'usage', label: 'Usage', href: 'activity-usage.html' },
      { id: 'logs', label: 'Logs', href: 'activity-logs.html' }
    ],
    active
  )

/**
 * Which of the two selectors decides a request at all.
 *
 * `ROUTER_MODE` is one envelope scalar for the whole install, so it sits
 * above the surface tabs on every Routing screen — it is a wider fact than
 * any surface, scenario or lane below it. Until it was on screen the Rules
 * editor and the Chain editor looked equally live while only ever one of
 * them ran, and the Rules screen is where that hurts: in `chain` mode a
 * rule only applies where its scenario's chain is empty.
 *
 * One stored value, so all four Routing mocks show the same one.
 */


/**
 * Providers master rail, shared by both detail mocks.
 *
 * The two lists exist because a subscription and an api_key provider
 * hold different things: accounts, a plan and a window that runs out on
 * one side, a secret and a price list on the other. The mock has one
 * detail of each kind, which is why every subscription row lands on
 * provider-subscription.html and every key row on provider-apikey.html.
 */
const PROVIDER_ROWS = [
  { id: 'claude-code', label: 'Claude Code', vendor: 'Anthropic', auth: 'subscription', plan: 'Max',    accounts: 2, key: null, models: '6 / 7',  quota: 71, state: 'live' },
  { id: 'codex',       label: 'Codex',       vendor: 'OpenAI',    auth: 'subscription', plan: 'Pro',    accounts: 1, key: null, models: '1 / 4',  quota: 88, state: 'live' },
  { id: 'gemini-cli',  label: 'Gemini CLI',  vendor: 'Google',    auth: 'subscription', plan: 'AI Pro', accounts: 1, key: null, models: '3 / 5',  quota: 12, state: 'invalid' },
  { id: 'anthropic',   label: 'Anthropic',   vendor: 'Anthropic', auth: 'api_key', host: 'api.anthropic.com', plan: null, accounts: 0, key: 'sk-ant-··········a91f', models: '4 / 12', quota: null, state: 'live' },
  { id: 'openai',      label: 'OpenAI',      vendor: 'OpenAI',    auth: 'api_key', host: 'api.openai.com', plan: null, accounts: 0, key: 'sk-proj-··········7c02', models: '5 / 18', quota: null, state: 'live' },
  { id: 'google',      label: 'Google',      vendor: 'Google',    auth: 'api_key', host: 'generativelanguage.googleapis.com', plan: null, accounts: 0, key: 'AIza··········be44', models: '4 / 9',  quota: null, state: 'live' },
  { id: 'deepseek',    label: 'DeepSeek',    vendor: 'DeepSeek',  auth: 'api_key', host: 'api.deepseek.com', plan: null, accounts: 0, key: 'not set', models: '0 / 3',  quota: null, state: 'unknown' }
]

const PROVIDER_STATE_TONE = { live: 'ok', invalid: 'bad', unknown: 'mute' }

const providerTable = (auth) => {
  const rows = PROVIDER_ROWS.filter((p) => p.auth === auth)
  const sub = auth === 'subscription'
  // The two lists answer the same question — "is this one healthy, and
  // what can it serve" — with the facts each kind actually has. A
  // subscription has a plan, accounts and a quota that runs out; an API
  // key has a secret and nothing that expires on its own. Giving both
  // the union of those columns would mean four dashes per row on one
  // side and three on the other.
  const head = sub
    ? `${sortTh('Provider', 'pl-6 pr-3')}${sortTh('Plan', 'px-3')}${sortTh('Accounts', 'px-3', 'right')}${sortTh('Quota', 'px-3', 'right', true, 'desc')}${sortTh('Models', 'px-3', 'right')}${sortTh('State', 'px-3', 'right')}`
    : `${sortTh('Provider', 'pl-6 pr-3')}${sortTh('Key', 'px-3')}${sortTh('Models', 'px-3', 'right')}${sortTh('State', 'px-3', 'right')}`
  const cols = sub
    ? '<col><col class="w-24"><col class="w-24"><col class="w-40"><col class="w-24"><col class="w-24"><col class="w-10">'
    : '<col><col class="w-56"><col class="w-24"><col class="w-24"><col class="w-10">'
  const row = (p) => `
    <tr ${navTo(sub ? 'provider-subscription.html' : 'provider-apikey.html')} class="cursor-pointer border-t border-border/60 transition-colors hover:bg-muted/50">
      <td class="py-2.5 pl-6 pr-3">
        <div class="text-xs font-medium">${p.label}</div>
        <!-- The vendor under a subscription (Claude Code is Anthropic's,
             and the two names are not the same word), the host under an
             API key (where they are: an "Anthropic / Anthropic" row says
             nothing twice, and the URL a key is spent against is the
             fact that identifies it). -->
        <div class="${sub ? '' : 'font-mono '}text-[12px] text-muted-foreground">${sub ? p.vendor : p.host}</div>
      </td>
      ${
        sub
          ? `<td class="px-3">${pill(p.plan, 'info')}</td>
      <td class="px-3 text-right font-mono text-xs tabular-nums">${p.accounts}</td>
      <td class="px-3">
        <div class="flex items-center gap-2">
          <div class="min-w-0 flex-1">${meter(p.quota)}</div>
          <span class="shrink-0 font-mono text-[12px] tabular-nums text-muted-foreground">${p.quota}%</span>
        </div>
      </td>`
          : `<td class="px-3 font-mono text-[12px] text-muted-foreground">${p.key}</td>`
      }
      <td class="px-3 text-right font-mono text-xs tabular-nums">${p.models}</td>
      <td class="px-3 text-right">${pill(p.state, PROVIDER_STATE_TONE[p.state])}</td>
      <td class="py-2.5 pl-3 pr-6">
        <div class="flex justify-end text-muted-foreground/50"><i class="ri-arrow-right-s-line text-base"></i></div>
      </td>
    </tr>`
  return `
  <table class="w-full table-fixed">
    <colgroup>${cols}</colgroup>
    <thead>
      <tr class="text-[12px] uppercase tracking-wider text-muted-foreground/70 [&>th]:h-9 [&>th]:whitespace-nowrap [&>th]:align-bottom [&>th]:pb-2">
        ${head}
        <th class="pl-3 pr-6"></th>
      </tr>
    </thead>
    <tbody>${rows.map(row).join('')}</tbody>
  </table>`
}

/**
 * Range footer for any unbounded list.
 *
 * Lived inline on Activity -> Sessions, which is how Requests and Logs
 * ended up rendering whatever the first fetch returned with no way to
 * reach the rest. One definition so the three cannot disagree.
 *
 * The range is spelled out rather than a page number: "26-50 of 128"
 * answers both "where am I" and "how much is there", and a page number
 * answers neither without knowing the page size. `total` is optional
 * because a count is not always cheap — without it the footer says
 * "26-50" and lets Next decide whether there is more.
 */
const pager = ({ first, last, total, hasPrev = true, hasNext = true, compact = false }) => {
  const range = `${first}-${last}${total === undefined ? '' : ` of ${total}`}`
  if (compact) {
    const arrow = (icon, on) =>
      `<button class="inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
        on ? 'text-muted-foreground hover:bg-muted/60 hover:text-foreground' : 'text-muted-foreground opacity-40'
      }" ${on ? '' : 'disabled'}><i class="${icon} text-sm"></i></button>`
    return `
  <div class="flex items-center gap-1 border-t border-border px-4 py-2">
    <span class="text-[12px] text-muted-foreground">${range}</span>
    <div class="ml-auto flex items-center">
      ${arrow('ri-arrow-left-s-line', hasPrev)}${arrow('ri-arrow-right-s-line', hasNext)}
    </div>
  </div>`
  }
  const ctl = (on) =>
    `inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors ${
      on ? 'hover:bg-muted/60' : 'text-muted-foreground opacity-50'
    }`
  return `
  <div class="flex items-center gap-3 border-t border-border px-6 py-3">
    <span class="text-[12px] text-muted-foreground">${range}</span>
    <div class="ml-auto flex items-center gap-2">
      <button class="${ctl(hasPrev)}" ${hasPrev ? '' : 'disabled'}>
        <i class="ri-arrow-left-s-line text-sm leading-none"></i>Previous
      </button>
      <button class="${ctl(hasNext)}" ${hasNext ? '' : 'disabled'}>
        Next<i class="ri-arrow-right-s-line text-sm leading-none"></i>
      </button>
    </div>
  </div>`
}

  global.Shell = {
    renderShell, ROW, section, dialog, pill, mono, meter, btn, pager,
    tabs, railItem, SETTINGS_RAIL,
    navTo, activityTabs, providerTable, tierCell, effortCell, sortTh, toast,
    SURFACES, surfacePill, surfaceChip, ACCESS_TOKENS, tokenTable,
    toggleTheme, currentTheme
  }
})(window)
