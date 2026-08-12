import { createSignal, createEffect, onCleanup, onMount, For, type JSX } from 'solid-js'
import type { Book } from '@shared/domain/types'
import { coverFor, requestRemoteCover } from './covers'
import {
  computeColumns,
  computeRange,
  GRID_CARD_WIDTH,
  GRID_COVER_HEIGHT,
  GRID_GAP,
  GRID_ROW_HEIGHT,
} from './virtualize'

/**
 * Virtualized adaptive cover grid.
 *
 * Only visible rows (plus overscan) are mounted — a 5,000-book library never
 * materializes 5,000 cards. Column count adapts to container width via
 * ResizeObserver. Scrolling only updates offsets; no layout thrash.
 */

const CARD_WIDTH = GRID_CARD_WIDTH
const GAP = GRID_GAP
const ROW_HEIGHT = GRID_ROW_HEIGHT

interface Props {
  books: () => Book[]
  selectedIndex: () => number
  onSelect: (index: number) => void
  onOpen: (index: number) => void
  gridRef?: (el: HTMLDivElement) => void
}

export function VirtualBookGrid(props: Props): JSX.Element {
  let container: HTMLDivElement | undefined
  const [size, setSize] = createSignal({ width: 0, height: 0 })
  const [scrollTop, setScrollTop] = createSignal(0)
  let raf = 0

  onMount(() => {
    if (!container) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(container)
    onCleanup(() => observer.disconnect())
  })

  const columns = () => computeColumns(size().width, CARD_WIDTH, GAP)

  const range = () =>
    computeRange(props.books().length, columns(), ROW_HEIGHT, scrollTop(), size().height)

  // rAF-throttled scroll: at most one state update per frame.
  const onScroll = (e: Event) => {
    const target = e.currentTarget as HTMLDivElement
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => setScrollTop(target.scrollTop))
  }
  onCleanup(() => cancelAnimationFrame(raf))

  // Keep the keyboard selection visible.
  createEffect(() => {
    const index = props.selectedIndex()
    if (index < 0 || !container) return
    const row = Math.floor(index / columns())
    const top = row * ROW_HEIGHT
    const bottom = top + ROW_HEIGHT
    if (top < container.scrollTop) container.scrollTop = top
    else if (bottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = bottom - container.clientHeight
    }
  })

  const visible = () => props.books().slice(range().start, range().end)

  return (
    <div
      class="book-grid-scroll"
      ref={(el) => {
        container = el
        props.gridRef?.(el)
      }}
      onScroll={onScroll}
      role="grid"
      aria-label="Library"
      aria-rowcount={Math.ceil(props.books().length / columns())}
    >
      <div style={{ height: `${range().totalHeight}px`, position: 'relative' }}>
        <div
          class="book-grid"
          style={{
            transform: `translateY(${range().offsetTop}px)`,
            'grid-template-columns': `repeat(${columns()}, ${CARD_WIDTH}px)`,
            gap: `${GAP}px`,
          }}
        >
          <For each={visible()}>
            {(book, localIndex) => {
              const index = () => range().start + localIndex()
              // Books that live on a server arrive with no cover art. Ask
              // for it as the card is mounted, which virtualization already
              // means is roughly "as it comes into view".
              requestRemoteCover(book)
              return (
                <button
                  type="button"
                  class="book-card"
                  classList={{ selected: props.selectedIndex() === index() }}
                  // One click opens. Selection still moves so the arrow keys
                  // carry on from wherever the last click landed.
                  onClick={() => {
                    props.onSelect(index())
                    props.onOpen(index())
                  }}
                  role="gridcell"
                  aria-selected={props.selectedIndex() === index()}
                  aria-label={`${book.title} by ${book.authors.join(', ')}`}
                >
                  <div class="book-cover-wrap">
                    <img
                      class="book-cover"
                      src={coverFor(book)}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      draggable={false}
                      width={CARD_WIDTH}
                      height={GRID_COVER_HEIGHT}
                    />
                    {book.finished && <span class="badge badge-finished">Finished</span>}
                    {book.downloaded && (
                      <span class="badge badge-downloaded" title="Downloaded">
                        ⬇
                      </span>
                    )}
                    {book.remoteId && (
                      <span class="badge badge-server" title="From a remote server">
                        ☁
                      </span>
                    )}
                  </div>
                  <span class="book-title">{book.title}</span>
                  <span class="book-author">{book.authors.join(', ')}</span>
                </button>
              )
            }}
          </For>
        </div>
      </div>
    </div>
  )
}
