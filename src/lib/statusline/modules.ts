import type { StatusLineConfig, StatusLineModuleConfig } from '@/types'
import { DEFAULT_MODULE } from './constants'
import { isThemeConfig } from './theme-config'

// Modules belonging to the currently active theme. `currentStyle` is a
// free-form nonempty string (see StatusLineConfigSchema) rather than a
// literal union, so indexing still needs a `keyof` narrowing.
export function getCurrentModules(config: StatusLineConfig): StatusLineModuleConfig[] {
  const themeConfig = config[config.currentStyle as keyof StatusLineConfig]
  return isThemeConfig(themeConfig) ? themeConfig.modules : []
}

// Return a new config with the current theme's modules replaced.
export function withCurrentModules(config: StatusLineConfig, modules: StatusLineModuleConfig[]): StatusLineConfig {
  const currentTheme = config.currentStyle as keyof StatusLineConfig
  return { ...config, [currentTheme]: { modules } }
}

export function removeModuleAt(modules: StatusLineModuleConfig[], index: number): StatusLineModuleConfig[] {
  return modules.filter((_module, i) => i !== index)
}

export function reorderModules(
  modules: StatusLineModuleConfig[],
  fromIndex: number,
  toIndex: number
): StatusLineModuleConfig[] {
  const next = [...modules]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}

// Default field values seeded when a module type is dropped onto the preview area.
export function createModuleForType(moduleType: string): StatusLineModuleConfig {
  switch (moduleType) {
    case 'workDir':
      return { type: 'workDir', icon: '󰉋', text: '{{workDirName}}', color: 'bright_blue', keepProvider: false }
    case 'gitBranch':
      return { type: 'gitBranch', icon: '🌿', text: '{{gitBranch}}', color: 'bright_green', keepProvider: false }
    case 'model':
      return { type: 'model', icon: '🤖', text: '{{model}}', color: 'bright_yellow', keepProvider: false }
    case 'usage':
      return {
        type: 'usage',
        icon: '📊',
        text: '{{inputTokens}} → {{outputTokens}}',
        color: 'bright_magenta',
        keepProvider: false
      }
    case 'speed':
      return { type: 'speed', icon: '⚡', text: '{{tokenSpeed}}', color: 'bright_green', keepProvider: false }
    case 'script':
      return {
        type: 'script',
        icon: '📜',
        text: 'Script Module',
        color: 'bright_cyan',
        scriptPath: '',
        keepProvider: false
      }
    default:
      return { ...DEFAULT_MODULE, type: moduleType }
  }
}
