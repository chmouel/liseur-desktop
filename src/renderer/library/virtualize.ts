/**
 * Pure virtualization math, kept separate from the component so it is unit
 * testable without a DOM.
 */

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
