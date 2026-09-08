/**
 * The shape a freshly added status-line module starts from.
 *
 * Three lookup tables used to live here too — a module-type list, a
 * Nerd Font glyph table and an ANSI colour map — and nothing imported
 * any of them: the palette reads its own table from
 * `lib/rialto/settings-content/statusline`, which is the one the editor
 * and the preview agree on. Two module catalogues meant the second could
 * (and did) drift out of step with what the line can actually render.
 */
import type { StatusLineModuleConfig } from '@/types'

export const DEFAULT_MODULE: StatusLineModuleConfig = {
  type: 'workDir',
  icon: '󰉋',
  text: '{{workDirName}}',
  color: 'bright_blue'
}
