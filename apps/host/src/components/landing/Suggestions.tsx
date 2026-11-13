// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For, Show, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { getSuggestionId, SUGGESTIONS_ID } from './suggestionIds.js';
import s from './Suggestions.module.css';

export type SuggestionsProps = {
  /** The names to suggest, as labels. None renders nothing. */
  labels: Accessor<readonly string[]>;
  /** The TLD shown after each label, with its leading dot. Null until the browser knows the visitor's network. */
  suffix: Accessor<string | null>;
  /** The label the arrow keys point at, or null. */
  active: Accessor<string | null>;
  /** A click on `label`'s option. */
  onPick: (label: string) => void;
};

/** Suggested names as a listbox the name input controls. */
export function Suggestions(props: SuggestionsProps): JSX.Element {
  return (
    <Show when={props.labels().length > 0}>
      <ul
        id={SUGGESTIONS_ID}
        class={s['list']}
        role="listbox"
        aria-label="Suggested names"
        data-testid="landing-suggestions"
      >
        <For each={props.labels()}>
          {label => (
            <li
              id={getSuggestionId(label)}
              class={s['option']}
              role="option"
              aria-selected={props.active() === label ? 'true' : 'false'}
              data-testid="landing-suggestion"
              data-label={label}
              onMouseDown={e => {
                // The input keeps focus, so its keys still drive the list. A touch tap fires this too.
                e.preventDefault();
              }}
              onClick={() => {
                props.onPick(label);
              }}
            >
              {label}
              <span class={s['suffix']}>{props.suffix() ?? ''}</span>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
