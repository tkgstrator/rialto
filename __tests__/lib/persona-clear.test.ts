import { expect, test } from 'bun:test'
import { splitPayload } from '../../src/services/config/apply'

const PERSONA_ID = 'b3f1c0a2-1d4e-4a7b-9c2f-1a2b3c4d5e6f'

// The active persona is envelope-bound (disk key `ActivePersona`, and the
// same key top-level on the wire), not a DB column. splitPayload
// distinguishes "clear the persona" from "this save didn't touch the
// persona" purely by whether the key is present — which is why the value
// the UI sends must be null and never undefined.

test('an explicit null clears the active persona', () => {
  const { envelope } = splitPayload({ ActivePersona: null })
  expect('ActivePersona' in envelope).toBe(true)
  expect(envelope.ActivePersona).toBe(null)
})

test('an empty string clears it too', () => {
  const { envelope } = splitPayload({ ActivePersona: '' })
  expect(envelope.ActivePersona).toBe(null)
})

test('a save that omits the key leaves the selection alone', () => {
  // Partial saves from other pages post without an ActivePersona key;
  // wiping the selection on those would be the mirror-image bug.
  const { envelope } = splitPayload({ Providers: [] })
  expect('ActivePersona' in envelope).toBe(false)
})

test('a persona id lands on the envelope', () => {
  const { envelope } = splitPayload({ ActivePersona: PERSONA_ID })
  expect(envelope.ActivePersona).toBe(PERSONA_ID)
})

test('undefined is indistinguishable from absent — the shape the UI must not send', () => {
  // Documents the regression: JSON.stringify drops an undefined value, so
  // a cleared persona sent as undefined arrives as an omitted key and the
  // old selection survives the save.
  const overTheWire = JSON.parse(JSON.stringify({ ActivePersona: undefined }))
  const { envelope } = splitPayload(overTheWire)
  expect('ActivePersona' in envelope).toBe(false)
})

test('the retired Router.persona spelling is dropped, not lifted', () => {
  // An old UI bundle still nesting the persona under Router gets the
  // whole Router key dropped with a warning; nothing is lifted out of
  // it, so a stale selection cannot be re-planted through a retired key.
  const { envelope, droppedKeys } = splitPayload({ Router: { persona: PERSONA_ID } })
  expect('ActivePersona' in envelope).toBe(false)
  expect('Router' in envelope).toBe(false)
  expect(droppedKeys).toEqual(['Router'])
})
