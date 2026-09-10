/**
 * The app's own model of what it routes and what it routes it with.
 *
 * `.openapi()` appears in several modules here even though registration
 * is an api-layer concern. It could not be moved: these components nest
 * (RouterPreferenceProfile -> PreferenceEntriesByScenario ->
 * PreferenceEntriesByKind -> RouterPreferenceEntry), and registering
 * only the outermost one in api/ would inline the inner ones in the
 * generated document instead of $ref-ing them. Relocating them properly
 * means renaming exported symbols, which Phase 4 does not do.
 *
 * Most of this layer is server-only — the pipeline, the solver input,
 * the disk envelope. Browser code should import the specific
 * module it needs (`@/schemas/domain/router`) rather than this barrel,
 * so that a Zod schema built for the request path never has to be
 * parsed by a browser to render a page.
 */

export * from './config'
export * from './pipeline'
export * from './preference'
export * from './preset'
export * from './provider'
export * from './router'
export * from './scenario'
export * from './solver-input'
export * from './status-line'
export * from './subscription'
export * from './tokenizer'
export * from './unified'
export * from './usage-record'
