/**
 * Pure helpers for the Status line settings section.
 *
 * The module types here are the ones `createModuleForType` builds. This
 * build ships no `rialto statusline` renderer, so they drive the editor and
 * its preview only; the icon/label pairs are that presentation.
 */
import { PREVIEW_VARIABLES, replaceVariables } from '@/lib/statusline/preview'
import type { StatusLineModuleConfig } from '@/types'
import { COLOR_HEX_MAP } from '@/utils/statusline'

export interface ModuleTypeMeta {
  type: string
  labelKey: string
  icon: string
}

/** Every module type the renderer understands, in palette order. */
export const MODULE_TYPES: ModuleTypeMeta[] = [
  { type: 'model', labelKey: 'settings.statusline.moduleModel', icon: 'ri-cpu-line' },
  { type: 'usage', labelKey: 'settings.statusline.moduleUsage', icon: 'ri-hashtag' },
  { type: 'speed', labelKey: 'settings.statusline.moduleSpeed', icon: 'ri-speed-line' },
  { type: 'gitBranch', labelKey: 'settings.statusline.moduleGitBranch', icon: 'ri-git-branch-line' },
  { type: 'workDir', labelKey: 'settings.statusline.moduleWorkDir', icon: 'ri-folder-line' },
  { type: 'script', labelKey: 'settings.statusline.moduleScript', icon: 'ri-terminal-box-line' }
]

const FALLBACK_META: ModuleTypeMeta = {
  type: '',
  labelKey: 'settings.statusline.moduleFallback',
  icon: 'ri-shapes-line'
}

/**
 * Presentation for a module type. A config written by hand can name a
 * type the palette does not list, so this never returns undefined.
 */
export function moduleMeta(type: string): ModuleTypeMeta {
  const known = MODULE_TYPES.find((m) => m.type === type)
  return known === undefined ? { ...FALLBACK_META, type } : known
}

// The shared preview map predates the `speed` module, so a speed module
// would print a literal {{tokenSpeed}}. Extended here rather than in
// lib/statusline, which the legacy dialog still binds to. `model` is the
// stripped form — the same tail every `provider,model` pair resolves to
// once `stripProvider` removes the vendor prefix — since that is the
// default a freshly added Model module renders.
const PREVIEW_VARS: Record<string, string> = { ...PREVIEW_VARIABLES, tokenSpeed: '48', model: 'claude-opus-4-8' }
const PREVIEW_MODEL_RAW = 'claude-code,claude-opus-4-8'

/**
 * One module as the terminal will print it: icon, substituted text, then
 * its separator. `keepProvider` only means something for `model` — every
 * other type ignores it.
 */
export function previewText(module: StatusLineModuleConfig): string {
  const vars =
    module.type === 'model' && module.keepProvider ? { ...PREVIEW_VARS, model: PREVIEW_MODEL_RAW } : PREVIEW_VARS
  const text = replaceVariables(module.text, vars)
  const icon = typeof module.icon === 'string' ? module.icon : ''
  const body = icon === '' ? text : `${icon} ${text}`
  return typeof module.separator === 'string' && module.separator !== '' ? `${body}${module.separator}` : body
}

const HEX_RE = /^#[0-9a-f]{6}$/i

/**
 * The hex a colour field resolves to, or null when it names nothing the
 * renderer knows. Colours are stored either as an ANSI name
 * (`bright_blue`) or as a literal hex, and the preview has to paint the
 * same pixel for both.
 */
export function colorHex(color: string | undefined): string | null {
  if (typeof color !== 'string' || color === '') return null
  if (HEX_RE.test(color)) return color
  return Object.hasOwn(COLOR_HEX_MAP, color) ? COLOR_HEX_MAP[color] : null
}

export interface Swatch {
  value: string
  hex: string
}

const swatch = (value: string): Swatch => {
  const hex = colorHex(value)
  return { value, hex: hex === null ? '#000000' : hex }
}

/** Foreground picks offered as swatches, spanning the usable ANSI range. */
export const FG_SWATCHES: Swatch[] = [
  'bright_blue',
  'bright_green',
  'bright_yellow',
  'bright_red',
  'white',
  'bright_black'
].map(swatch)

/** Background picks, only meaningful under the powerline style. */
export const BG_SWATCHES: Swatch[] = [
  'bg_bright_blue',
  'bg_bright_green',
  'bg_bright_yellow',
  'bg_bright_red',
  'bg_white',
  'bg_bright_black'
].map(swatch)

/** Move one module within the line, returning a new array. */
export function moveModule(modules: StatusLineModuleConfig[], from: number, to: number): StatusLineModuleConfig[] {
  const moved = modules[from]
  if (moved === undefined || to < 0 || to >= modules.length) return modules
  const without = modules.filter((_m, i) => i !== from)
  return [...without.slice(0, to), moved, ...without.slice(to)]
}
