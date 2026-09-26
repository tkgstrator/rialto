import type { Logger } from 'pino'

export type ClassifierSignals = {
  safeguardsPresent: boolean
  suspectedClassifier: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function hasSafeguards(body: unknown): boolean {
  return Object.hasOwn(record(body) ?? {}, 'safeguards')
}

// This is an observed Claude Code permission-gate phrase, not a protocol marker.
// Search only bounded text in known prompt locations; never write the text to logs.
export function classifierSignals(body: Record<string, unknown>): ClassifierSignals {
  const system = body.system
  const blocks = Array.isArray(system) ? system : [system]
  const suspectedClassifier = blocks.some((block) => {
    const text = typeof block === 'string' ? block : record(block)?.text
    return typeof text === 'string' && text.includes('Stage 1 does NOT apply user intent')
  })
  return { safeguardsPresent: hasSafeguards(body), suspectedClassifier }
}

// Only inspect small, non-streaming JSON responses. A clone of an unbounded SSE
// stream can buffer indefinitely if its consumer lags the actual client.
export function captureSafeguardResultMetadata(response: Response, log: Logger): void {
  const contentType = response.headers.get('content-type') ?? ''
  const declaredLength = response.headers.get('content-length')
  const length = Number(declaredLength)
  if (
    !contentType.toLowerCase().includes('application/json') ||
    declaredLength === null ||
    !Number.isInteger(length) ||
    length < 0 ||
    length > 65536
  )
    return
  void readBoundedJson(response.clone(), 65536)
    .then((data) => {
      const result = record(data)?.safeguard_results
      if (result === undefined) return
      log.info(
        {
          event: 'classifier_diagnostic',
          phase: 'upstream_safeguard_result',
          safeguardResultsPresent: true,
          safeguardResultCount: Array.isArray(result) ? result.length : undefined
        },
        'classifier diagnostic: upstream safeguard result metadata'
      )
    })
    .catch(() => {})
}

async function readBoundedJson(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) return undefined
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder().decode(bytes))
  } finally {
    // Cancel without awaiting: a tee branch may wait on the other consumer.
    void reader.cancel().catch(() => {})
  }
}
