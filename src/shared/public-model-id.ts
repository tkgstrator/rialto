export interface ModelTarget {
  provider: string
  model: string
}

export const qualifiedModelId = (target: ModelTarget): string => `${target.provider},${target.model}`

/** The public id never exposes Rialto's internal provider selection. */
export const publicModelId = (target: ModelTarget): string => target.model
