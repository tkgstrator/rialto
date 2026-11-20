import { normaliseContent } from './message-content'

const MAX_INPUT_CHARS = 4096

function textBlocks(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = content.flatMap((block) => {
    if (block === null || typeof block !== 'object') return []
    const type = Reflect.get(block, 'type')
    const text = Reflect.get(block, 'text')
    if (
      (type !== undefined && type !== 'text' && type !== 'input_text') ||
      Reflect.get(block, 'thought') === true ||
      typeof text !== 'string'
    )
      return []
    return [{ type: 'text', text }]
  })
  return normaliseContent(parts)
    .flatMap((block) => (block.kind === 'text' ? [block.text] : []))
    .join('\n')
    .trim()
}

export function firstUserInputOf(body: Record<string, unknown>): string | null {
  if (typeof body.input === 'string') {
    const input = body.input.trim()
    return input === '' ? null : input.slice(0, MAX_INPUT_CHARS)
  }
  const text = [() => userTextIn(body.messages), () => userTextIn(body.input), () => userTextIn(body.contents, 'user')]
  for (const read of text) {
    const input = read()
    if (input !== null) return input.slice(0, MAX_INPUT_CHARS)
  }
  return null
}

function userTextIn(items: unknown, defaultRole?: 'user'): string | null {
  if (!Array.isArray(items)) return null
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    const role = Reflect.get(item, 'role')
    if (role !== 'user' && (role !== undefined || defaultRole !== 'user')) continue
    const content = Reflect.get(item, 'content')
    const text = textBlocks(content === undefined ? Reflect.get(item, 'parts') : content)
    if (text !== '') return text
  }
  return null
}
