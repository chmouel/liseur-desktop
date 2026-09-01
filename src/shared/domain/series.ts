import type { SeriesMembership } from './types'

/** Parses the untrusted series payload used by sync and the library database. */
export function parseSeriesMemberships(value: unknown): SeriesMembership[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((membership) => {
    if (!membership || typeof membership !== 'object') return []
    const raw = membership as { id?: unknown; name?: unknown; position?: unknown }
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!name) return []
    const position =
      typeof raw.position === 'number' && Number.isFinite(raw.position) ? raw.position : undefined
    return [
      {
        ...(typeof raw.id === 'string' && raw.id ? { id: raw.id } : {}),
        name,
        ...(position !== undefined ? { position } : {}),
      },
    ]
  })
}
