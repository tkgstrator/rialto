---
name: ui-mock-diff
description: Build a UI screen against an approved static mock and verify it by Retina screenshot diff. Use when implementing or refining any screen that has a mock under mocks/, when asked to compare the UI to its mock, or when asked to capture/diff mock vs implementation screenshots. Covers building the mock stylesheet, capturing both sides at deviceScaleFactor 2, reading the diff report, and closing the gap.
---

# UI mock diff

Implement a React screen so it matches its approved static mock, and prove it
with pixel evidence rather than by eyeballing.

The mocks under `mocks/` are the **design contract**. A human approves the mock
first; the React screen is then built to match it, and this skill measures how
far off it is.

## Why the mock is a fair target

`mocks/_shared/mock.css` is compiled by the project's own Tailwind
(`@tailwindcss/node` + the oxide scanner — the same compiler the app's Vite
build uses) and carries a verbatim copy of the `:root` / `.dark`
token blocks from `src/index.css`. The build **refuses to run** if those blocks
drift. Both sides load the same Inter / Geist Mono / Remix Icon files from
`node_modules`. So a pixel that differs is a design difference, not a toolchain
difference.

## Workflow

### 1. Build the mock stylesheet

```bash
bun run mocks:css          # add --watch while editing mocks
```

Run this after **any** edit to a mock's markup — Tailwind only emits the
utilities it finds in `mocks/**`.

To let a human look at the mocks in a browser, `bun run mocks:serve` does the
build, arms the watcher, and serves them on :16176 (allowlisted to `mocks/**`
plus the two font/icon packages). Rendering over that server is pixel-identical
to `file://`, which is what the capture below uses.

If it fails with `mock.css token drift`, `src/index.css` changed. Copy the
changed `:root` / `.dark` block into `mocks/_shared/mock.css` and rebuild. Do
not bypass the check — every diff after a drift measures the wrong thing.

### 2. Register the screen

`mocks/mocks.json` maps each screen to its mock file and its React route:

```json
{ "name": "routing", "mock": "routing.html", "route": "/routing" }
```

`route: null` means "mock only, not implemented yet" — the impl capture and the
diff skip it cleanly. Set the route when you start implementing.

### 3. Capture

```bash
bun run mocks:shoot                                   # every screen, both themes, both sides
bun run mocks:shoot -- --screen routing --side mock   # one screen, mock only
bun run mocks:shoot -- --screen routing --theme dark
```

- 1440×900 at `deviceScaleFactor: 2` → 2880×1800 PNGs.
- If it dies on a missing chromium, playwright is looking for its own pinned
  build. Point it at the one this machine has with
  `RIALTO_CHROMIUM_PATH=<path to chrome>` (the E2E suite reads the same var).
- Transitions, animations and the caret are frozen; webfonts are awaited.
- Output: `mocks/.shots/<screen>.<theme>.<side>.png`.
- Theme is deterministic: each theme gets a fresh browser context (empty
  storage, matching `colorScheme`), and the capture sets the `dark` class
  explicitly after load. The mocks' own persisted-theme toggle only writes
  storage on an explicit click, so it never leaks between captures.

**Never start the app dev server.** One is already running (see `mocks.json`
`baseUrl`) and it belongs to the user. If it is unreachable the impl side is
reported as skipped — say so and ask, do not start one. (`mocks:serve` is a
different, purpose-built process and is fine to start.)

The impl side gets past `ProtectedRoute` with no credential: the capture runs
on the same machine as the dev server, and a browser there is exempt from the
admin gate.

### 4. Diff

```bash
bun run mocks:diff
bun run mocks:diff -- --screen routing --theme dark
bun run mocks:diff -- --fail-over 2      # non-zero exit over 2%
```

Writes `<screen>.<theme>.diff.png` (magenta = differs, grey ghost = matches)
and `mocks/.shots/report.json`.

### 5. Read the result properly

**The headline percentage understates the problem.** Both pages are mostly
background, so two completely unrelated screens still score under 10%. Use it
only as a trend across iterations.

**The `regions` list is the real signal.** Each entry is a 64-device-px cell
(≈32 CSS px) with ≥2% of its pixels differing, sorted worst-first, in device
pixels — halve the coordinates to get CSS pixels. Read the top few, open the
diff PNG, and fix the largest block first.

Also check `status`:

| status | meaning |
|---|---|
| `compared` | normal |
| `size-mismatch` | one side has a scrollbar or a different viewport — fix before trusting the numbers |
| `missing-impl` | `route: null`, or the dev server was unreachable |
| `missing-mock` | mock not captured yet |

### 6. Converge

Iterate step 3 → 4 → fix. Realistic targets:

| mismatch | verdict |
|---|---|
| < 1% | done — antialiasing and subpixel text only |
| 1–3% | close; usually one spacing or weight value |
| 3–10% | a block is structurally different |
| > 10% | wrong layout, wrong theme, or a failed capture |

Do not chase 0%. React renders real data where the mock has fixtures, so some
text-width difference is expected and correct.

## Rules when implementing from a mock

- **`src/components/ui/*.tsx` is off limits.** shadcn owns those files; change
  them only via `bunx shadcn@latest add <component> --overwrite`.
- **No shadcn `Card`.** The mocks use the flat house pattern — a `border-l`
  accent plus `hover:bg-muted/50`. Match it.
- **One metric per table cell.** Never pack `71% / 3d 04h` into one column; the
  mocks give each its own right-aligned `tabular-nums` mono column.
- **Money is 3 significant figures** and comes from the existing `fmtCost` —
  import it, never write another formatter.
- **Copy the mock's markup structure, not its scripts.** The mocks build
  strings via `window.Shell` helpers because static HTML has no components;
  React gets real components with the same classes.
- Comments in code are English (repo rule).

## Files

| path | role |
|---|---|
| `mocks/*.html` | the mocks — one per screen |
| `mocks/_shared/shell.js` | sidebar / header chrome + shared primitives |
| `mocks/_shared/mock.css` | Tailwind entry; token blocks mirror `src/index.css` |
| `mocks/_shared/mock.build.css` | generated — never hand-edit |
| `mocks/mocks.json` | screen registry: mock file ↔ React route |
| `mocks/.shots/` | screenshots, diffs, `report.json` — gitignored |
| `scripts/build-mock-css.ts` | `bun run mocks:css` |
| `scripts/serve-mocks.ts` | `bun run mocks:serve` — human review on :16176 |
| `.claude/skills/ui-mock-diff/scripts/shoot.ts` | `bun run mocks:shoot` |
| `.claude/skills/ui-mock-diff/scripts/diff.ts` | `bun run mocks:diff` |

Mocks open directly over `file://` — no server, no CDN — and that is what the
capture uses. `bun run mocks:serve` puts the same files on :16176 for a human
reviewer who needs a URL (another device, a forwarded port, a tunnel).
