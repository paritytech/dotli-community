// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For, Show, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Listbox } from '@dotli/ui';
import { ClockIcon } from '@dotli/ui/icons';
import { getSuggestionId, SUGGESTIONS_ID } from './suggestionIds.js';

export type SuggestionsProps = {
  /** The recently visited names to suggest, newest first. None leaves out their section. */
  recent: Accessor<readonly string[]>;
  /** The app names to suggest. None leaves out their section. With no name at all, nothing renders unless `loading`. */
  apps: Accessor<readonly string[]>;
  /** True while more names may still come, shown as a loading row after the names. */
  loading: Accessor<boolean>;
  /** The TLD shown after each name, with its leading dot. Null until the browser knows the visitor's network. */
  suffix: Accessor<string | null>;
  /** The name the arrow keys point at, or null. */
  active: Accessor<string | null>;
  /** A click on `label`'s option. */
  onPick: (label: string) => void;
  /** A click on the cross of `label`'s recent option. */
  onForget: (label: string) => void;
};

/** Suggested names as a listbox the name input controls: the recent names, then the app names, each under a heading. */
export function Suggestions(props: SuggestionsProps): JSX.Element {
  return (
    <Show when={props.recent().length > 0 || props.apps().length > 0 || props.loading()}>
      <Listbox
        id={SUGGESTIONS_ID}
        label="Suggested names"
        loading={props.loading() ? 'Loading names…' : undefined}
        testId="landing-suggestions"
      >
        <Show when={props.recent().length > 0}>
          <Listbox.Group label="Recent">
            <For each={props.recent()}>
              {label => (
                <Listbox.Option
                  id={getSuggestionId(label)}
                  icon={ClockIcon}
                  detail={props.suffix() ?? undefined}
                  active={props.active() === label}
                  remove={{
                    label: `Remove ${label}${props.suffix() ?? ''} from recently visited`,
                    onRemove: () => {
                      props.onForget(label);
                    },
                  }}
                  onPick={() => {
                    props.onPick(label);
                  }}
                  testId="landing-suggestion"
                >
                  {label}
                </Listbox.Option>
              )}
            </For>
          </Listbox.Group>
        </Show>
        <Show when={props.apps().length > 0}>
          <Listbox.Group label="Apps">
            <For each={props.apps()}>
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
          </Listbox.Group>
        </Show>
      </Listbox>
    </Show>
  );
}
