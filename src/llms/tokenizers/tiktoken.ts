/**
 * Tiktoken-backed tokenizer.
 *
 * Wraps the `tiktoken` package. The default `cl100k_base` encoding is the
 * one Claude / GPT-4 family models use and is also the fallback for any
 * provider that doesn't configure a more specific tokenizer.
 */

import { get_encoding, type Tiktoken, type TiktokenEncoding } from 'tiktoken'
import type { ProviderTokenizerConfig } from '@/schemas/domain/tokenizer'
import { isTokenizeContentBlock, type TokenizeContentBlock, type TokenizeRequest, Tokenizer } from './base'

const DEFAULT_ENCODING: TiktokenEncoding = 'cl100k_base'

function isProviderTokenizerConfig(
  value: TiktokenEncoding | ProviderTokenizerConfig
): value is ProviderTokenizerConfig {
  return typeof value !== 'string'
}

function isTiktokenEncoding(value: string | undefined): value is TiktokenEncoding {
  // Only the encoding names tiktoken ships. Keep this list in sync with
  // the `TiktokenEncoding` union from the upstream package.
  if (!value) return false
  const known: readonly string[] = ['cl100k_base', 'p50k_base', 'p50k_edit', 'r50k_base', 'gpt2', 'o200k_base']
  return known.includes(value)
}

function readBlockText(part: TokenizeContentBlock): string | undefined {
  const text = Reflect.get(part, 'text')
  return typeof text === 'string' ? text : undefined
}

function readBlockInput(part: TokenizeContentBlock): unknown {
  return Reflect.get(part, 'input')
}

function readBlockContent(part: TokenizeContentBlock): unknown {
  return Reflect.get(part, 'content')
}

export class TiktokenTokenizer extends Tokenizer {
  private encoding: Tiktoken | undefined

  /**
   * Accepts either a raw encoding name or a `ProviderTokenizerConfig`
   * whose `model` field is the encoding name. Defaults to `cl100k_base`.
   */
  constructor(encodingOrConfig: TiktokenEncoding | ProviderTokenizerConfig = DEFAULT_ENCODING) {
    super()
    const encodingName = this.resolveEncoding(encodingOrConfig)
    try {
      this.encoding = get_encoding(encodingName)
    } catch {
      throw new Error(`Failed to initialize tiktoken encoding: ${encodingName}`)
    }
  }

  private resolveEncoding(encodingOrConfig: TiktokenEncoding | ProviderTokenizerConfig): TiktokenEncoding {
    if (!isProviderTokenizerConfig(encodingOrConfig)) return encodingOrConfig
    const model = encodingOrConfig.model
    return isTiktokenEncoding(model) ? model : DEFAULT_ENCODING
  }

  override async initialize(): Promise<void> {
    if (!this.encoding) throw new Error('Tiktoken encoding not initialized')
  }

  async countTokens(request: TokenizeRequest): Promise<number> {
    const encoding = this.encoding
    if (!encoding) throw new Error('Encoding not initialized')

    return (
      this.countMessages(encoding, request.messages) +
      this.countSystem(encoding, request.system) +
      this.countTools(encoding, request.tools)
    )
  }

  private countMessages(encoding: Tiktoken, messages: TokenizeRequest['messages']): number {
    if (!Array.isArray(messages)) return 0
    let n = 0
    for (const message of messages) {
      if (typeof message.content === 'string') {
        n += encoding.encode(message.content).length
        continue
      }
      if (Array.isArray(message.content)) {
        for (const part of message.content) n += this.countContentBlock(encoding, part)
      }
    }
    return n
  }

  private countSystem(encoding: Tiktoken, system: TokenizeRequest['system']): number {
    if (typeof system === 'string') return encoding.encode(system).length
    if (!Array.isArray(system)) return 0
    let n = 0
    for (const item of system) {
      if (item.type === 'text') n += this.countSystemTextField(encoding, item.text)
    }
    return n
  }

  private countSystemTextField(encoding: Tiktoken, text: string | string[] | undefined): number {
    if (typeof text === 'string') return encoding.encode(text).length
    if (!Array.isArray(text)) return 0
    let n = 0
    for (const part of text) {
      if (typeof part === 'string') n += encoding.encode(part).length
    }
    return n
  }

  private countTools(encoding: Tiktoken, tools: TokenizeRequest['tools']): number {
    if (!tools) return 0
    let n = 0
    for (const tool of tools) {
      if (tool.description) n += encoding.encode(tool.name + tool.description).length
      if (tool.input_schema) n += encoding.encode(JSON.stringify(tool.input_schema)).length
    }
    return n
  }

  private countContentBlock(encoding: Tiktoken, part: TokenizeContentBlock): number {
    if (part.type === 'text') {
      const text = readBlockText(part)
      return text !== undefined ? encoding.encode(text).length : 0
    }
    if (part.type === 'tool_use') {
      const input = readBlockInput(part)
      const text = input !== undefined ? JSON.stringify(input) : ''
      return encoding.encode(text).length
    }
    if (part.type === 'tool_result') return this.countToolResult(encoding, readBlockContent(part))
    return 0
  }

  // A tool_result's content is either a string or an array of blocks in
  // the same vocabulary as a message's — text, image, document. Counting
  // the array by JSON.stringify weighed a nested image's base64 payload
  // as prose (one screenshot read as a million tokens and pushed every
  // request after it into the longContext lane); walking it block by
  // block counts the text and, like a top-level image block, weighs the
  // media at 0. Anything else — an object a Responses caller returned
  // as a tool output — is still serialised, since it is text-shaped.
  private countToolResult(encoding: Tiktoken, content: unknown): number {
    if (content === undefined) return 0
    if (typeof content === 'string') return encoding.encode(content).length
    if (Array.isArray(content)) {
      return content.reduce<number>(
        (n, item) => n + (isTokenizeContentBlock(item) ? this.countContentBlock(encoding, item) : 0),
        0
      )
    }
    return encoding.encode(JSON.stringify(content)).length
  }
}
