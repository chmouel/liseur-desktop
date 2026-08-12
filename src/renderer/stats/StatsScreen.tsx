import { createSignal, For, onMount, Show, type JSX } from 'solid-js'
import type { ReadingStats } from '@shared/ipc/protocol'

/**
 * Reading statistics, matching the phone screen so the same numbers are read
 * the same way on both. This machine's own records are shown at once; if a
 * sync server answers, the headline is replaced by a figure that counts
 * every device, and the period label says so.
 */

/** "1 h 20 min", the way the phone writes it. */
export function readingDuration(ms: number): string {
  if (ms <= 0) return 'None'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'Less than a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} hr` : `${hours} h ${rest} min`
}

function bookSubtitle(book: ReadingStats['books'][number]): string {
  const progress = book.finished
    ? 'Read'
    : book.progression !== undefined
      ? `${Math.round(book.progression * 100)}% through`
      : ''
  return [book.author, progress].filter(Boolean).join(' · ')
}

export function StatsScreen(props: { onClose: () => void }): JSX.Element {
  const [stats, setStats] = createSignal<ReadingStats | null>(null)
  const [failed, setFailed] = createSignal(false)

  onMount(() => {
    void window.liseur.stats
      .get()
      .then(setStats)
      .catch((err: Error) => {
        console.error('reading stats failed', err)
        setFailed(true)
      })
  })

  const period = (): string => {
    const s = stats()
    if (!s) return ''
    return s.source === 'server' && s.rangeDays
      ? `In the last ${s.rangeDays} days, on every device`
      : 'In total'
  }

  // Bars are drawn against the busiest day of the week rather than a fixed
  // scale, so a quiet week is still legible.
  const peak = (): number => Math.max(1, ...(stats()?.week ?? []).map((day) => day.ms))

  return (
    <div class="stats-overlay" role="dialog" aria-label="Reading statistics">
      <div class="stats-panel">
        <header class="stats-header">
          <h1>Reading statistics</h1>
          <button type="button" class="icon-button" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <Show
          when={stats()}
          fallback={
            <p class="stats-loading">
              {failed() ? 'Could not read your statistics.' : 'Adding it up…'}
            </p>
          }
        >
          {(s) => (
            <Show
              when={s().totalMs > 0 || s().books.length > 0}
              fallback={<p class="stats-empty">Nothing recorded yet.</p>}
            >
              <section class="stats-headline">
                <p class="stats-headline-label">Time spent reading</p>
                <p class="stats-headline-value">{readingDuration(s().totalMs)}</p>
                <p class="stats-headline-period">{period()}</p>
              </section>

              <section class="stats-tally">
                <div class="stats-tally-item">
                  <span class="stats-tally-value">{s().booksReadFrom}</span>
                  <span class="stats-tally-label">Books read from</span>
                </div>
                <div class="stats-tally-item">
                  <span class="stats-tally-value">{s().booksFinished}</span>
                  <span class="stats-tally-label">Books finished</span>
                </div>
                <div class="stats-tally-item">
                  <span class="stats-tally-value">{s().streakDays}</span>
                  <span class="stats-tally-label">Day streak</span>
                </div>
                <div class="stats-tally-item">
                  <span class="stats-tally-value">{s().sittings}</span>
                  <span class="stats-tally-label">Sittings</span>
                </div>
              </section>

              <section class="stats-section">
                <h2>This past week</h2>
                <div class="stats-week">
                  <For each={s().week}>
                    {(day) => (
                      <div class="stats-day" classList={{ today: day.today }}>
                        <div class="stats-day-track">
                          <div
                            class="stats-day-bar"
                            style={{ height: `${Math.round((day.ms / peak()) * 100)}%` }}
                            title={`${day.date}: ${readingDuration(day.ms)}`}
                          />
                        </div>
                        <span class="stats-day-label">{day.weekday}</span>
                      </div>
                    )}
                  </For>
                </div>
              </section>

              <section class="stats-section">
                <h2>By book</h2>
                <ul class="stats-books">
                  <For each={s().books}>
                    {(book) => (
                      <li class="stats-book" data-book={book.bookId}>
                        <div class="stats-book-text">
                          <span class="stats-book-title">{book.title}</span>
                          <Show when={bookSubtitle(book)}>
                            <span class="stats-book-subtitle">{bookSubtitle(book)}</span>
                          </Show>
                        </div>
                        <span class="stats-book-duration">{readingDuration(book.ms)}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>
          )}
        </Show>
      </div>
    </div>
  )
}
