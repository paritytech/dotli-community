// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './TextField.module.css';

/** A labelled single-line field, with optional fixed text after it. */
export function TextInput(props: {
  id: string;
  testId: string;
  label: string;
  value: string;
  suffix?: string | undefined;
  disabled?: boolean | undefined;
  /** Text taken as typed, such as a username: no autofill, capitalisation, autocorrect or spellcheck. */
  verbatim?: boolean;
  onInput: (value: string) => void;
}): JSX.Element {
  const off = (): 'off' | undefined => (props.verbatim === true ? 'off' : undefined);
  return (
    <div class={s['field']}>
      <label class={s['label']} for={props.id}>
        {props.label}
      </label>
      <div class={s['affixed']}>
        <input
          id={props.id}
          type="text"
          class={s['input']}
          data-testid={props.testId}
          disabled={props.disabled}
          autocomplete={off()}
          autocapitalize={off()}
          autocorrect={off()}
          spellcheck={props.verbatim === true ? 'false' : undefined}
          value={props.value}
          onInput={event => {
            props.onInput(event.currentTarget.value);
          }}
        />
        <Show when={props.suffix}>{suffix => <span class={s['suffix']}>{suffix()}</span>}</Show>
      </div>
    </div>
  );
}
