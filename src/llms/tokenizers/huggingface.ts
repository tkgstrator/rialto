/**
 * HuggingFace-backed tokenizer.
 *
 * Downloads `tokenizer.json` and `tokenizer_config.json` for the configured
 * repo from huggingface.co (caching them under
 * `~/.rialto/.huggingface`) and feeds them to
 * `@huggingface/tokenizers` for real model-accurate token counts on
 * open-source models.
 */

import { existsSync, promises as fs, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Tokenizer as HFTokenizer } from '@huggingface/tokenizers'
import type { Logger } from 'pino'
import type { ProviderTokenizerConfig } from '@/schemas/domain/tokenizer'
import { isTokenizeContentBlock, type TokenizeContentBlock, type TokenizeRequest, Tokenizer } from './base'

export type HuggingFaceTokenizerOptions = {
  /** Network timeout (ms) when downloading vocab files. Defaults to 30s. */
  timeout?: number
  /** Override the on-disk cache directory. */
  cacheDir?: string
  /** Optional pino logger; falls back to silence. */
  logger?: Logger
}

type CachedTokenizerFiles = {
  tokenizerJson: object
  tokenizerConfig: object
}

export class HuggingFaceTokenizer extends Tokenizer {
  private readonly modelId: string
  private readonly logger: Logger | undefined
  private readonly timeout: number
  private readonly cacheDir: string
  private readonly safeModelName: string
  private tokenizer: HFTokenizer | null = null

  constructor(config: ProviderTokenizerConfig, options: HuggingFaceTokenizerOptions = {}) {
    super()
    if (!config.model) {
      throw new Error('HuggingFace tokenizer requires `model` (the HF repo id)')
    }
    this.modelId = config.model
    this.logger = options.logger
    this.timeout = options.timeout !== undefined ? options.timeout : 30_000
    this.cacheDir = options.cacheDir ? options.cacheDir : join(homedir(), '.rialto', '.huggingface')
    // Cache safe model name to avoid repeated regex operations
    this.safeModelName = this.modelId.replace(/\//g, '_').replace(/[^a-zA-Z0-9_-]/g, '_')
  }

  override async initialize(): Promise<void> {
    try {
      this.logger?.info(`Initializing HuggingFace tokenizer: ${this.modelId}`)
      this.ensureDir(this.cacheDir)

      const cached = await this.loadFromCache()
      const data = cached ? cached : await this.downloadAndCache()
      this.tokenizer = new HFTokenizer(data.tokenizerJson, data.tokenizerConfig)

      this.logger?.info(`HuggingFace tokenizer initialized for ${this.modelId}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger?.error(`Failed to initialize HuggingFace tokenizer: ${message}`)
      throw new Error(`Failed to initialize HuggingFace tokenizer for ${this.modelId}: ${message}`)
    }
  }

  async countTokens(request: TokenizeRequest): Promise<number> {
    const tokenizer = this.tokenizer
    if (!tokenizer) {
      throw new Error('Tokenizer not initialized')
    }
    try {
      const text = this.extractTextFromRequest(request)
      return tokenizer.encode(text).ids.length
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger?.error(`Error counting tokens: ${message}`)
      throw error
    }
  }

  // ─── cache helpers ────────────────────────────────────────────────────

  private getCachePaths(): { modelDir: string; tokenizerJson: string; tokenizerConfig: string } {
    const modelDir = join(this.cacheDir, this.safeModelName)
    return {
      modelDir,
      tokenizerJson: join(modelDir, 'tokenizer.json'),
      tokenizerConfig: join(modelDir, 'tokenizer_config.json')
    }
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  private async loadFromCache(): Promise<CachedTokenizerFiles | null> {
    try {
      const paths = this.getCachePaths()
      if (!existsSync(paths.tokenizerJson) || !existsSync(paths.tokenizerConfig)) {
        return null
      }
      const [tokenizerJsonContent, tokenizerConfigContent] = await Promise.all([
        fs.readFile(paths.tokenizerJson, 'utf-8'),
        fs.readFile(paths.tokenizerConfig, 'utf-8')
      ])
      return {
        tokenizerJson: asObject(JSON.parse(tokenizerJsonContent)),
        tokenizerConfig: asObject(JSON.parse(tokenizerConfigContent))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger?.warn(`Failed to load HF tokenizer from cache: ${message}`)
      return null
    }
  }

  private async downloadAndCache(): Promise<CachedTokenizerFiles> {
    const paths = this.getCachePaths()
    const urls = {
      json: `https://huggingface.co/${this.modelId}/resolve/main/tokenizer.json`,
      config: `https://huggingface.co/${this.modelId}/resolve/main/tokenizer_config.json`
    }

    this.logger?.info(`Downloading tokenizer files for ${this.modelId}`)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      const [jsonRes, configRes] = await Promise.all([
        fetch(urls.json, { signal: controller.signal }),
        fetch(urls.config, { signal: controller.signal })
      ])

      if (!jsonRes.ok) {
        throw new Error(`Failed to fetch tokenizer.json: ${jsonRes.statusText}`)
      }

      const [tokenizerJsonRaw, tokenizerConfigRaw] = await Promise.all([
        jsonRes.json(),
        configRes.ok ? configRes.json() : Promise.resolve({})
      ])
      const tokenizerJson = asObject(tokenizerJsonRaw)
      const tokenizerConfig = asObject(tokenizerConfigRaw)

      this.ensureDir(paths.modelDir)
      await Promise.all([
        fs.writeFile(paths.tokenizerJson, JSON.stringify(tokenizerJson, null, 2)),
        fs.writeFile(paths.tokenizerConfig, JSON.stringify(tokenizerConfig, null, 2))
      ])

      return { tokenizerJson, tokenizerConfig }
    } finally {
      clearTimeout(timeoutId)
    }
  }

  // ─── request → string flattening ──────────────────────────────────────

  private extractTextFromRequest(request: TokenizeRequest): string {
    const parts: string[] = []
    this.collectMessageText(parts, request.messages)
    this.collectSystemText(parts, request.system)
    this.collectToolsText(parts, request.tools)
    return parts.join(' ')
  }

  private collectMessageText(parts: string[], messages: TokenizeRequest['messages']): void {
    if (!Array.isArray(messages)) return
    for (const message of messages) {
      if (typeof message.content === 'string') {
        parts.push(message.content)
        continue
      }
      if (!Array.isArray(message.content)) continue
      for (const block of message.content) {
        const text = this.flattenContentBlock(block)
        if (text) parts.push(text)
      }
    }
  }

  private collectSystemText(parts: string[], system: TokenizeRequest['system']): void {
    if (typeof system === 'string') {
      parts.push(system)
      return
    }
    if (!Array.isArray(system)) return
    for (const item of system) {
      if (item.type !== 'text') continue
      this.collectSystemItemText(parts, item.text)
    }
  }

  private collectSystemItemText(parts: string[], text: string | string[] | undefined): void {
    if (typeof text === 'string') {
      parts.push(text)
      return
    }
    if (!Array.isArray(text)) return
    for (const part of text) {
      if (part) parts.push(part)
    }
  }

  private collectToolsText(parts: string[], tools: TokenizeRequest['tools']): void {
    if (!tools) return
    for (const tool of tools) {
      if (tool.name) parts.push(tool.name)
      if (tool.description) parts.push(tool.description)
      if (tool.input_schema) parts.push(JSON.stringify(tool.input_schema))
    }
  }

  private flattenContentBlock(block: TokenizeContentBlock): string {
    if (block.type === 'text') {
      const text = Reflect.get(block, 'text')
      return typeof text === 'string' ? text : ''
    }
    if (block.type === 'tool_use') {
      const input: unknown = Reflect.get(block, 'input')
      return input === undefined ? '' : JSON.stringify(input)
    }
    if (block.type === 'tool_result') return this.flattenToolResult(Reflect.get(block, 'content'))
    return ''
  }

  // Same rule as the tiktoken backend: a block array inside a tool_result
  // is walked block by block so an image's base64 payload is not read as
  // prose, while any other JSON shape is still serialised.
  private flattenToolResult(content: unknown): string {
    if (content === undefined) return ''
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .filter(isTokenizeContentBlock)
        .map((item) => this.flattenContentBlock(item))
        .filter((text) => text.length > 0)
        .join(' ')
    }
    return JSON.stringify(content)
  }
}

function asObject(value: unknown): object {
  return typeof value === 'object' && value !== null ? value : {}
}
