import { For, Show, type JSX } from 'solid-js'
import {
  formatBinding,
  groupBindings,
  LIBRARY_BINDINGS,
  READER_BINDINGS,
  type VimBinding,
} from './keymap'

/**
 * The `?` sheet. It is generated from the binding tables rather than written
 * out by hand, so a key that exists is a key that is documented — there is no
 * second list to forget to update.
 */
export function VimHelp(props: { scope: 'library' | 'reader'; onClose: () => void }): JSX.Element {
  const bindings = (): readonly VimBinding<string>[] =>
    props.scope === 'library' ? LIBRARY_BINDINGS : READER_BINDINGS

  return (
    <div class="vim-help-overlay" onClick={props.onClose}>
      <div
        class="vim-help-panel"
        role="dialog"
        aria-label="Vim keys"
        // A click inside the sheet is reading, not dismissing.
        onClick={(e) => e.stopPropagation()}
      >
        <header class="vim-help-header">
          <h1>{props.scope === 'library' ? 'Vim keys — library' : 'Vim keys — reader'}</h1>
          <button type="button" class="icon-button" aria-label="Close" onClick={props.onClose}>
            ×
          </button>
        </header>
        <div class="vim-help-groups">
          <For each={groupBindings(bindings())}>
            {(group) => (
              <section class="vim-help-group">
                <h2>{group.group}</h2>
                <dl>
                  <For each={group.bindings}>
                    {(binding) => (
                      <div class="vim-help-row">
                        <dt>
                          <kbd>{formatBinding(binding)}</kbd>
                        </dt>
                        <dd>{binding.description}</dd>
                      </div>
                    )}
                  </For>
                </dl>
              </section>
            )}
          </For>
        </div>
        <p class="vim-help-footer">
          A number before a key repeats it: <kbd>5j</kbd>. <kbd>Esc</kbd> drops a half-typed
          sequence
          {props.scope === 'reader' ? ', and again leaves the book' : ''}. Arrows, space and the
          menu shortcuts keep working as they always did.
        </p>
      </div>
    </div>
  )
}

/** The half-typed sequence, shown where vim shows it: bottom right. */
export function VimPending(props: { pending: () => string }): JSX.Element {
  return (
    <Show when={props.pending()}>
      {(pending) => (
        <div class="vim-pending" aria-hidden="true">
          {pending()}
        </div>
      )}
    </Show>
  )
}
