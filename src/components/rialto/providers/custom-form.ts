/**
 * What the Custom provider's form knows without asking the server.
 *
 * Kept free of React for the same reason `form-logic.ts` is: the rules are
 * the interesting part and a plain function is the cheapest thing to test.
 * The name and Base URL rules themselves are the shared ones the server
 * enforces (`@/shared/custom-provider`), so the form warns about exactly
 * what the API would refuse and nothing else.
 */
import {
  type CustomApiStyle,
  type CustomNameProblem,
  customEndpointUrl,
  customNameProblem,
  parseCustomBaseUrl
} from '@/shared/custom-provider'
import type { CatalogEntry } from './types'

/**
 * The rail's Custom card. The catalog is built from vendors Rialto knows,
 * so a hand-added endpoint has no row of its own; this stands in for it.
 * Everything the flow reads off an entry is present and empty: there is no
 * catalog of models and no fixed address to show.
 */
export const CUSTOM_ENTRY_NAME = 'custom'

export const CUSTOM_ENTRY: CatalogEntry = {
  name: CUSTOM_ENTRY_NAME,
  displayName: 'Custom',
  authMode: 'api_key',
  apiBaseUrl: 'https://',
  vendor: 'Custom',
  cli: null,
  credentialsPath: null,
  models: [],
  enabled: false,
  lastRefreshedAt: null
}

/** The catalog with the Custom card appended, unless a build already carries one. */
export const withCustomEntry = (catalog: readonly CatalogEntry[]): CatalogEntry[] =>
  catalog.some((e) => e.name === CUSTOM_ENTRY_NAME) ? [...catalog] : [...catalog, CUSTOM_ENTRY]

export const isCustomEntry = (entry: CatalogEntry | undefined): boolean =>
  entry !== undefined && entry.name === CUSTOM_ENTRY_NAME

export interface CustomDraft {
  name: string
  baseUrl: string
  apiKey: string
  style: CustomApiStyle
}

// Chat Completions first: it is what nearly every local server and gateway
// speaks, so it is the choice a form that is filled in without thinking
// should land on.
export const EMPTY_CUSTOM_DRAFT: CustomDraft = { name: '', baseUrl: '', apiKey: '', style: 'openai_chat' }

// 'empty' is left out on purpose: an untouched field reports nothing, so the
// form never has a blank name to complain about.
export type CustomFieldProblem = Exclude<CustomNameProblem, 'empty'> | 'taken' | 'invalid_base_url'

export interface CustomDraftProblems {
  name: CustomFieldProblem | null
  baseUrl: 'invalid_base_url' | null
}

/**
 * Whether a typed name is already a provider. Case-insensitive, like the
 * server: two names that differ by case would be one in every URL and log.
 */
const isTaken = (name: string, existing: readonly string[]): boolean => {
  const lowered = name.trim().toLowerCase()
  return existing.some((e) => e.toLowerCase() === lowered)
}

/**
 * The problem with each field, for fields that have been typed in. A field
 * left empty reports none: an empty form is not an error, it only keeps the
 * button disabled (see `isCustomDraftReady`), and a red field before the
 * first keystroke reads as a scolding.
 */
export function customDraftProblems(draft: CustomDraft, existing: readonly string[]): CustomDraftProblems {
  const name = draft.name.trim()
  const namePart = ((): CustomFieldProblem | null => {
    if (name === '') return null
    const shared = customNameProblem(name)
    if (shared !== null && shared !== 'empty') return shared
    return isTaken(name, existing) ? 'taken' : null
  })()
  const baseUrl = draft.baseUrl.trim() === '' || parseCustomBaseUrl(draft.baseUrl) !== null ? null : 'invalid_base_url'
  return { name: namePart, baseUrl }
}

/** Every field filled in and none of them refused. */
export function isCustomDraftReady(draft: CustomDraft, existing: readonly string[]): boolean {
  if (draft.name.trim() === '' || draft.baseUrl.trim() === '' || draft.apiKey.trim() === '') return false
  const problems = customDraftProblems(draft, existing)
  return problems.name === null && problems.baseUrl === null
}

/** The address a request will go to, or null while the Base URL is not an address yet. */
export const customEndpointPreview = (draft: CustomDraft): string | null =>
  draft.baseUrl.trim() === '' ? null : customEndpointUrl(draft.baseUrl, draft.style)

export type ModelIdProblem = 'empty' | 'space' | 'duplicate'

/**
 * Check a hand-typed model ID before it is sent. Nothing is looked up: the
 * endpoint is the only judge of whether it serves the model, so this only
 * refuses what could never be one — nothing, a string with whitespace in it —
 * and a repeat of an ID the provider already lists.
 */
export function modelIdProblem(raw: string, existing: readonly string[]): ModelIdProblem | null {
  const id = raw.trim()
  if (id === '') return 'empty'
  if (/\s/.test(id)) return 'space'
  return existing.includes(id) ? 'duplicate' : null
}
