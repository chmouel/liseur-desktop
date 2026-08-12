/**
 * Pure pagination math for the column reader engine. Kept DOM-free so it is
 * exhaustively unit-testable; the engine only feeds in measurements.
 *
 * Model: a spine item is laid out as CSS multi-columns of fixed width; one
 * screenful ("page") is `columns` columns wide. Positions are 0-based page
 * numbers; progression within an item is page/pageCount (first page = 0, so
 * a book only reaches 1 when the reader goes past the last page — which the
 * engine reports as end-of-book).
 */

export function pageCountFor(scrollWidth: number, pageWidth: number): number {
  if (pageWidth <= 0) return 1
  return Math.max(1, Math.ceil(scrollWidth / pageWidth))
}

export function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(0, Math.round(page)), Math.max(0, pageCount - 1))
}

/** 0..1 within one spine item. */
export function progressionInItem(page: number, pageCount: number): number {
  return page / Math.max(1, pageCount)
}

/**
 * 0..1 across the whole book. Page counts are measured lazily as chapters
 * are visited; unmeasured items are estimated at the average of measured
 * ones, so early estimates self-correct as the reader progresses.
 *
 * Convention: non-linear spine items carry a count of 0 — linear page
 * turning skips them, so they must not weigh on the total (or progression
 * could go backwards when crossing one).
 */
export function totalProgression(
  pageCounts: readonly (number | null)[],
  spineIndex: number,
  page: number,
): number {
  if (pageCounts.length === 0) return 0
  const measured = pageCounts.filter((n): n is number => n !== null && n > 0)
  const estimate = measured.length > 0 ? measured.reduce((a, b) => a + b, 0) / measured.length : 1

  let total = 0
  let before = 0
  for (let i = 0; i < pageCounts.length; i++) {
    const count = pageCounts[i] ?? estimate
    if (i < spineIndex) before += count
    total += count
  }
  return Math.min(1, (before + page) / Math.max(1, total))
}

/** Inverse of progressionInItem, for restoring a saved locator. */
export function pageForProgression(progression: number, pageCount: number): number {
  return clampPage(Math.round(progression * pageCount), pageCount)
}

/**
 * Maps a 0..1 total progression (e.g. from the scrubber) to a spine item +
 * within-item progression. Skips non-linear items (count 0); unmeasured
 * items use the running estimate, and the within-item fraction survives the
 * correction when the target item gets measured for real on load.
 */
export function targetForProgression(
  pageCounts: readonly (number | null)[],
  fraction: number,
): { spineIndex: number; itemProgression: number } {
  if (pageCounts.length === 0) return { spineIndex: 0, itemProgression: 0 }
  const measured = pageCounts.filter((n): n is number => n !== null && n > 0)
  const estimate = measured.length > 0 ? measured.reduce((a, b) => a + b, 0) / measured.length : 1
  const counts = pageCounts.map((c) => (c === null ? estimate : c))
  const total = counts.reduce((a, b) => a + b, 0)
  if (total <= 0) return { spineIndex: 0, itemProgression: 0 }

  let target = Math.min(Math.max(fraction, 0), 1) * total
  let lastNavigable = 0
  for (let i = 0; i < counts.length; i++) {
    const count = counts[i] ?? 0
    if (count > 0) lastNavigable = i
    // Strictly less: an exact boundary means "start of the next item".
    if (count > 0 && target < count) {
      return { spineIndex: i, itemProgression: target / count }
    }
    target -= count
  }
  return { spineIndex: lastNavigable, itemProgression: 1 }
}
