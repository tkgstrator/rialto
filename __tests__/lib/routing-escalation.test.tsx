import { describe, expect, test } from 'bun:test'
import { createInstance } from 'i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { EscalationRestrictions } from '../../src/components/rialto/routing/EscalationRestrictions'
import { RoutingConstraintsSchema, TierProfileWriteSchema } from '../../src/schemas/domain/tier-route'

const i18n = createInstance()
await i18n.init({ lng: 'en', resources: { en: { translation: {} } }, initImmediate: false })

const render = (editing: boolean) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <EscalationRestrictions selected={['opus', 'fable']} editing={editing} onChange={() => {}} />
    </I18nextProvider>
  )

describe('escalation restriction editor', () => {
  test('shows all four choices and the persisted selection in read mode', () => {
    const html = render(false)
    expect(html.match(/type="checkbox"/g)).toHaveLength(4)
    expect(html.match(/checked=""/g)).toHaveLength(2)
    expect(html.match(/disabled=""/g)).toHaveLength(4)
    expect(html).toContain('opus')
    expect(html).toContain('fable')
    expect(html).toContain('sonnet')
    expect(html).toContain('haiku')
  })

  test('Edit unlocks the choices without adding a demotion restriction', () => {
    const html = render(true)
    expect(html).not.toContain('disabled=""')
    expect(html.match(/type="checkbox"/g)).toHaveLength(4)
  })

  test('existing profiles default to no restrictions and invalid tiers are rejected', () => {
    const read = RoutingConstraintsSchema.safeParse({})
    expect(read.success && read.data.blockedEscalationTiers).toEqual([])
    expect(RoutingConstraintsSchema.safeParse({ blockedEscalationTiers: ['unknown'] }).success).toBe(false)
  })

  test('omitted writes preserve restrictions while an empty selection clears them', () => {
    const omitted = TierProfileWriteSchema.safeParse({ routes: {} })
    expect(omitted.success && omitted.data.constraints.blockedEscalationTiers).toBe(null)
    const cleared = TierProfileWriteSchema.safeParse({ routes: {}, constraints: { blockedEscalationTiers: [] } })
    expect(cleared.success && cleared.data.constraints.blockedEscalationTiers).toEqual([])
  })
})
