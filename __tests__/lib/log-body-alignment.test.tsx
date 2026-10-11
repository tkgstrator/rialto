import { describe, expect, test } from 'bun:test'
import { createInstance } from 'i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { LogBody } from '../../src/components/rialto/activity/LogBody'
import { LOG_LEVELS, parseLogLines } from '../../src/components/rialto/activity/log-lines'

const i18n = createInstance()
await i18n.init({ lng: 'en', resources: { en: { translation: {} } }, initImmediate: false })

const render = (level: string) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <LogBody
        lines={parseLogLines([
          JSON.stringify({ level, time: 1791435629917, msg: 'Synthetic alignment regression', status: 429 })
        ])}
      />
    </I18nextProvider>
  )

describe('log row alignment', () => {
  test.each(LOG_LEVELS)('%s shares centered cells and a full-height gutter', (level) => {
    const html = render(level)
    const summary = html.match(/<summary class="([^"]+)"/)
    expect(summary).not.toBeNull()
    expect(summary?.[1].split(' ')).toContain('items-center')

    const cells = Array.from(html.matchAll(/<span class="([^"]+)"/g), (match) => match[1].split(' ')).slice(0, 4)
    expect(cells).toHaveLength(4)
    expect(cells[0]).toContain('self-stretch')
    for (const cell of cells.slice(1)) {
      expect(cell).toContain('leading-5')
      expect(cell).toContain('py-1.5')
    }
    expect(cells[1]).toContain('text-[12px]')
    expect(cells[2]).toContain('text-[11px]')
    expect(cells[3]).toContain('text-[12px]')
    expect(cells[3]).toContain('truncate')
    expect(html).toContain(`>${level}</span>`)
    expect(html).not.toContain('<pre')
  })
})
