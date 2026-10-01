import { expect, test } from 'bun:test'
import { publicModelId, qualifiedModelId } from '../../src/shared/public-model-id'

test('all public model ids are bare while qualified targets remain internal', () => {
  const targets = [
    { provider: 'codex', model: 'gpt-5.6-sol' },
    { provider: 'openai', model: 'gpt-5.6-sol' },
    { provider: 'codex', model: 'gpt-6-sol' }
  ]
  expect(targets.map(publicModelId)).toEqual(['gpt-5.6-sol', 'gpt-5.6-sol', 'gpt-6-sol'])
  expect(qualifiedModelId(targets[2])).toBe('codex,gpt-6-sol')
})
