import imageModels from '../../shared/data/providers/openai/image-models.json'
import { CODEX_IMAGE_MODELS } from '../../shared/data/subscriptions'
import { fetchScrapePage } from '../base'

export interface ImageModelDetails {
  snapshot: string
  textInputPer1M: number
  cachedTextInputPer1M: number
  imageInputPer1M: number
  cachedImageInputPer1M: number
  imageOutputPer1M: number
  endpoints: string[]
  inputModalities: string[]
  outputModalities: string[]
  source: string
}

const DOCS_BASE = 'https://developers.openai.com/api/docs/models/'
const label = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const number = (raw: string): number | null => {
  const value = Number(raw.replace(/,/g, ''))
  return Number.isFinite(value) && value >= 0 ? value : null
}

// Restrict every match to its labeled modality block: text and image input
// have different rates, even though both blocks call their first cell Input.
const modality = (html: string, name: 'Text' | 'Image'): string | null => {
  const start = html.indexOf(`>${name} tokens</div>`)
  if (start < 0) return null
  const end = html.indexOf(name === 'Text' ? '>Image tokens</div>' : '>Modalities</div>', start)
  if (end < 0 || end - start > 12_000) return null
  const block = html.slice(start, end)
  return /Per 1M tokens/.test(block) ? block : null
}

const rate = (block: string, key: string): number | null => {
  const match = block.match(new RegExp(`>${label(key)}</div>\\s*<div[^>]*>\\s*\\$([0-9][0-9,.]*)</div>`, 'i'))
  return match === null ? null : number(match[1])
}

export function parseImageModelPage(html: string, model: string): ImageModelDetails | null {
  if (!CODEX_IMAGE_MODELS.includes(model)) return null
  if (!html.includes(`rel="canonical" href="${DOCS_BASE}${model}"`)) return null
  const text = modality(html, 'Text')
  const image = modality(html, 'Image')
  if (text === null || image === null) return null
  const textInputPer1M = rate(text, 'Input')
  const cachedTextInputPer1M = rate(text, 'Cached input')
  const imageInputPer1M = rate(image, 'Input')
  const cachedImageInputPer1M = rate(image, 'Cached input')
  const imageOutputPer1M = rate(image, 'Output')
  const snapshot = html.match(new RegExp(`(?:>|")(${label(model)}-\\d{4}-\\d{2}-\\d{2})(?:<|")`))?.[1]
  if (
    textInputPer1M === null ||
    cachedTextInputPer1M === null ||
    imageInputPer1M === null ||
    cachedImageInputPer1M === null ||
    imageOutputPer1M === null ||
    snapshot === undefined
  )
    return null
  return {
    snapshot,
    textInputPer1M,
    cachedTextInputPer1M,
    imageInputPer1M,
    cachedImageInputPer1M,
    imageOutputPer1M,
    endpoints: ['v1/images/generations', 'v1/images/edits'],
    inputModalities: ['text', 'image'],
    outputModalities: ['image'],
    source: `${DOCS_BASE}${model}`
  }
}

const snapshot = imageModels.models
export const imageModelSnapshot = (model: string): ImageModelDetails | null => {
  if (model === 'gpt-image-2.5-flare') return { ...snapshot[model], source: `${DOCS_BASE}${model}` }
  if (model === 'gpt-image-2.5-sunburst') return { ...snapshot[model], source: `${DOCS_BASE}${model}` }
  return null
}

export async function refreshImageModelDetails(): Promise<Map<string, ImageModelDetails>> {
  const fetched = await Promise.all(
    CODEX_IMAGE_MODELS.map(async (model) => {
      const html = await fetchScrapePage(`${DOCS_BASE}${model}`).catch(() => null)
      return { model, details: html === null ? null : parseImageModelPage(html, model) }
    })
  )
  return new Map(fetched.flatMap(({ model, details }) => (details === null ? [] : [[model, details]])))
}
