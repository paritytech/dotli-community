// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For, Show, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Listbox } from '@dotli/ui';
import { getSuggestionId, SUGGESTIONS_ID } from './suggestionIds.js';

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
      <Listbox id={SUGGESTIONS_ID} label="Suggested names" testId="landing-suggestions">
        <For each={props.labels()}>
          {label => (
            <Listbox.Option
              id={getSuggestionId(label)}
              detail={props.suffix() ?? undefined}
              active={props.active() === label}
              onPick={() => {
                props.onPick(label);
              }}
              testId="landing-suggestion"
            >
              {label}
            </Listbox.Option>
          )}
        </For>
      </Listbox>
    </Show>
  );
}
