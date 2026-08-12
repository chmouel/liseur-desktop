/**
 * Pure virtualization math, kept separate from the component so it is unit
 * testable without a DOM.
 */

/**
 * Book grid metrics. They live here rather than in the component because the
 * keyboard needs them too: moving a row or a screenful is the same arithmetic
 * the grid lays itself out with, and two copies of it would drift.
 */
export const GRID_CARD_WIDTH = 128
export const GRID_COVER_HEIGHT = 192
export const GRID_CARD_HEIGHT = GRID_COVER_HEIGHT + 44 // cover + title + author
export const GRID_GAP = 20
export const GRID_ROW_HEIGHT = GRID_CARD_HEIGHT + GRID_GAP

export interface VirtualRange {
  /** First visible item index (inclusive). */
  start: number
  /** One past the last visible item index. */
  end: number
  /** Pixels of spacer above the rendered window. */
  offsetTop: number
  /** Total content height in pixels. */
  totalHeight: number
  /** Items per row at the current width. */
  columns: number
}

export function computeColumns(containerWidth: number, cardWidth: number, gap: number): number {
  if (containerWidth <= 0) return 1
  return Math.max(1, Math.floor((containerWidth + gap) / (cardWidth + gap)))
}

export function computeRange(
  itemCount: number,
  columns: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscanRows = 3,
): VirtualRange {
  const totalRows = Math.ceil(itemCount / columns)
  const totalHeight = totalRows * rowHeight

  const firstVisibleRow = Math.max(0, Math.floor(scrollTop / rowHeight))
  const lastVisibleRow = Math.min(totalRows, Math.ceil((scrollTop + viewportHeight) / rowHeight))

  const startRow = Math.max(0, firstVisibleRow - overscanRows)
  const endRow = Math.min(totalRows, lastVisibleRow + overscanRows)

  return {
    start: startRow * columns,
    end: Math.min(itemCount, endRow * columns),
    offsetTop: startRow * rowHeight,
    totalHeight,
    columns,
  }
}
