import type { StatusLineConfig } from '@/types'

// `validateStatusLineConfig` / `formatValidationError` / `ValidationResult`
// lived here as stubs "kept for callers that still import this surface"
// after validation was removed. There were no such callers — only
// `createDefaultStatusLineConfig` and `COLOR_HEX_MAP` below are imported
// anywhere. The stubs were also the sole reference to the locale key
// `statusline.validation.unknown_error`, which no locale file declared,
// so they made the key-parity check fail for a screen nothing rendered.

// Color enum to hex value mapping
export const COLOR_HEX_MAP: Record<string, string> = {
  black: '#000000',
  red: '#cd0000',
  green: '#00cd00',
  yellow: '#cdcd00',
  blue: '#0000ee',
  magenta: '#cd00cd',
  cyan: '#00cdcd',
  white: '#e5e5e5',
  bright_black: '#7f7f7f',
  bright_red: '#ff0000',
  bright_green: '#00ff00',
  bright_yellow: '#ffff00',
  bright_blue: '#5c5cff',
  bright_magenta: '#ff00ff',
  bright_cyan: '#00ffff',
  bright_white: '#ffffff',
  bg_black: '#000000',
  bg_red: '#cd0000',
  bg_green: '#00cd00',
  bg_yellow: '#cdcd00',
  bg_blue: '#0000ee',
  bg_magenta: '#cd00cd',
  bg_cyan: '#00cdcd',
  bg_white: '#e5e5e5',
  bg_bright_black: '#7f7f7f',
  bg_bright_red: '#ff0000',
  bg_bright_green: '#00ff00',
  bg_bright_yellow: '#ffff00',
  bg_bright_blue: '#5c5cff',
  bg_bright_magenta: '#ff00ff',
  bg_bright_cyan: '#00ffff',
  bg_bright_white: '#ffffff'
}

/**
 * Create the default StatusLine configuration
 */
export function createDefaultStatusLineConfig(): StatusLineConfig {
  return {
    enabled: true,
    currentStyle: 'default',
    default: {
      modules: [
        { type: 'workDir', icon: '󰉋', text: '{{workDirName}}', color: 'bright_blue', keepProvider: false },
        { type: 'gitBranch', icon: '', text: '{{gitBranch}}', color: 'bright_magenta', keepProvider: false },
        { type: 'model', icon: '󰚩', text: '{{model}}', color: 'bright_cyan', keepProvider: false },
        { type: 'usage', icon: '↑', text: '{{inputTokens}}', color: 'bright_green', keepProvider: false },
        { type: 'usage', icon: '↓', text: '{{outputTokens}}', color: 'bright_yellow', keepProvider: false },
        { type: 'speed', icon: '', text: '{{tokenSpeed}} t/s', color: 'bright_red', keepProvider: false }
      ]
    },
    powerline: {
      modules: [
        {
          type: 'workDir',
          icon: '󰉋',
          text: '{{workDirName}}',
          color: 'white',
          background: 'bg_bright_blue',
          keepProvider: false
        },
        {
          type: 'gitBranch',
          icon: '',
          text: '{{gitBranch}}',
          color: 'white',
          background: 'bg_bright_magenta',
          keepProvider: false
        },
        {
          type: 'model',
          icon: '󰚩',
          text: '{{model}}',
          color: 'white',
          background: 'bg_bright_cyan',
          keepProvider: false
        },
        {
          type: 'usage',
          icon: '↑',
          text: '{{inputTokens}}',
          color: 'white',
          background: 'bg_bright_green',
          keepProvider: false
        },
        {
          type: 'usage',
          icon: '↓',
          text: '{{outputTokens}}',
          color: 'white',
          background: 'bg_bright_yellow',
          keepProvider: false
        },
        {
          type: 'speed',
          icon: '',
          text: '{{tokenSpeed}} t/s',
          color: 'white',
          background: 'bg_bright_red',
          keepProvider: false
        }
      ]
    }
  }
}
