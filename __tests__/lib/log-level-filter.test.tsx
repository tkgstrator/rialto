import { describe, expect, test } from 'bun:test'
import { createInstance } from 'i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { LogPane } from '../../src/components/rialto/activity/ActivityLogs'
import { parseLogLines } from '../../src/components/rialto/activity/log-lines'
import { LEVEL_CHIPS, type LevelChip } from '../../src/components/rialto/activity/log-view'

const i18n = createInstance()
await i18n.init({ lng: 'en', resources: { en: { translation: {} } }, initImmediate: false })

const FILE = { name: 'a.log', path: '/logs/a.log', size: 10, lastModified: '2026-10-21T00:00:00.000Z' }

const LINES = parseLogLines(
  LEVEL_CHIPS.map((level) => JSON.stringify({ level, time: 1791435629917, msg: `${level} line marker` }))
)

const render = (levels: ReadonlySet<LevelChip>) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <LogPane
        files={[FILE]}
        file={FILE}
        onSelectFile={() => {}}
        levels={levels}
        onLevelsChange={() => {}}
        lines={LINES}
      />
    </I18nextProvider>
  )

const chipStates = (html: string) =>
  Array.from(html.matchAll(/aria-pressed="(true|false)"[^>]*>(error|warn|info|debug)<\/button>/g), (m) => [
    m[2],
    m[1] === 'true'
  ])

// The Logs screen remounts LogPane on every file switch (`key={file.path}`) so the search and
// the page reset with the file. The level filter must not ride along, which only holds while
// ActivityLogs owns it and LogPane merely renders what it is handed. There is no DOM
// environment in this suite (no happy-dom / jsdom, and the sibling component tests are all
// static markup), so the file switch itself cannot be driven here; this pins the ownership that
// makes it safe: the chips and the visible lines are a function of the `levels` prop alone.
describe('log level filter is owned above the per-file pane', () => {
  test('a fresh set of all four levels shows every chip on and every line', () => {
    const html = render(new Set(LEVEL_CHIPS))
    expect(chipStates(html)).toEqual(LEVEL_CHIPS.map((level) => [level, true]))
    for (const level of LEVEL_CHIPS) expect(html).toContain(`${level} line marker`)
  })

  test.each(LEVEL_CHIPS)('%s handed in as off renders off, and the others stay on', (off) => {
    const html = render(new Set(LEVEL_CHIPS.filter((level) => level !== off)))
    expect(chipStates(html)).toEqual(LEVEL_CHIPS.map((level) => [level, level !== off]))
    expect(html).not.toContain(`${off} line marker`)
    for (const level of LEVEL_CHIPS.filter((l) => l !== off)) expect(html).toContain(`${level} line marker`)
  })
})
