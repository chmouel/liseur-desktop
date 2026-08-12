import { Show, type JSX } from 'solid-js'
import type { Book } from '@shared/domain/types'
import { coverFor } from './covers'

/**
 * "Continue reading" card: the shelf with whatever you were last reading on
 * top — cover, label, title, author, progress bar and percent.
 */

export function ContinueReading(props: { book: Book | null; onOpen: () => void }): JSX.Element {
  const percent = () =>
    Math.round(((props.book?.progress?.progression ?? 0) * 100 + Number.EPSILON) * 10) / 10

  return (
    <Show when={props.book}>
      {(book) => (
        <button type="button" class="continue-reading" onClick={props.onOpen}>
          <img
            class="continue-cover"
            src={coverFor(book())}
            alt=""
            width={72}
            height={108}
            draggable={false}
          />
          <div class="continue-body">
            <span class="continue-label">Continue reading</span>
            <span class="continue-title">{book().title}</span>
            <span class="continue-author">{book().authors.join(', ')}</span>
            <div class="continue-progress-row">
              <div
                class="continue-progress"
                role="progressbar"
                aria-valuenow={percent()}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Reading progress"
              >
                <div class="continue-progress-fill" style={{ width: `${percent()}%` }} />
              </div>
              <span class="continue-percent">{percent()}%</span>
            </div>
          </div>
        </button>
      )}
    </Show>
  )
}
