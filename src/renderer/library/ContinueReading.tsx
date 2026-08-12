import { Show, type JSX } from 'solid-js'
import type { Book } from '@shared/domain/types'
import { coverFor } from './covers'

/**
 * "Continue reading" banner: the shelf with whatever you were last reading
 * on top. It is the thing on the library screen you are most likely to
 * click, so it gets a full-size cover and the width of the window rather
 * than a thin strip above the grid.
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
            width={132}
            height={198}
            decoding="async"
            draggable={false}
          />
          <div class="continue-body">
            <span class="continue-label">Continue reading</span>
            <span class="continue-title">{book().title}</span>
            <Show when={book().authors.length > 0}>
              <span class="continue-author">{book().authors.join(', ')}</span>
            </Show>
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
          {/* A span, not a button: the whole card is already the button and
              nesting one inside another is invalid. */}
          <span class="continue-resume">Resume</span>
        </button>
      )}
    </Show>
  )
}
