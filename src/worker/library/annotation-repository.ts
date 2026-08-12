import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Annotation, HighlightColor, Locator } from '../../shared/domain/types'

/**
 * Annotation persistence: highlights and bookmarks for a book. Locators are
 * stored as JSON; the renderer re-anchors them from text context, so they
 * survive typography changes, repagination and app restarts.
 */

interface AnnotationRow {
  id: string
  book_id: string
  kind: string
  color: string | null
  note: string | null
  locator: string
  created_at: number
  updated_at: number
}

function rowToAnnotation(row: AnnotationRow): Annotation {
  const annotation: Annotation = {
    id: row.id,
    bookId: row.book_id,
    kind: row.kind === 'bookmark' ? 'bookmark' : 'highlight',
    locator: JSON.parse(row.locator) as Locator,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.color !== null) annotation.color = row.color as HighlightColor
  if (row.note !== null) annotation.note = row.note
  return annotation
}

export class AnnotationRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(bookId: string): Annotation[] {
    const rows = this.db
      .prepare('SELECT * FROM annotations WHERE book_id = ? ORDER BY created_at')
      .all(bookId) as unknown as AnnotationRow[]
    return rows.map(rowToAnnotation)
  }

  create(input: {
    bookId: string
    kind: 'highlight' | 'bookmark'
    locator: Locator
    color?: HighlightColor
    note?: string
  }): Annotation {
    const now = Date.now()
    const id = createHash('sha256')
      .update(`${input.bookId}:${now}:${Math.random()}`)
      .digest('hex')
      .slice(0, 16)
    this.db
      .prepare(
        `INSERT INTO annotations (id, book_id, kind, color, note, locator, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.bookId,
        input.kind,
        input.color ?? null,
        input.note ?? null,
        JSON.stringify(input.locator),
        now,
        now,
      )
    return {
      id,
      bookId: input.bookId,
      kind: input.kind,
      color: input.color,
      note: input.note,
      locator: input.locator,
      createdAt: now,
      updatedAt: now,
    }
  }

  update(
    id: string,
    patch: { color?: HighlightColor | null; note?: string | null },
  ): Annotation | undefined {
    const existing = this.get(id)
    if (!existing) return undefined
    const color = patch.color === undefined ? (existing.color ?? null) : patch.color
    const note = patch.note === undefined ? (existing.note ?? null) : patch.note
    const now = Date.now()
    this.db
      .prepare('UPDATE annotations SET color = ?, note = ?, updated_at = ? WHERE id = ?')
      .run(color, note, now, id)
    return this.get(id)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM annotations WHERE id = ?').run(id)
  }

  get(id: string): Annotation | undefined {
    const row = this.db.prepare('SELECT * FROM annotations WHERE id = ?').get(id) as unknown as
      AnnotationRow | undefined
    return row ? rowToAnnotation(row) : undefined
  }
}
