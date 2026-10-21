// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './TextArea.module.css';

/** A labelled multi-line field. */
export function TextArea(props: {
  id: string;
  testId: string;
  label: string;
  value: string;
  rows?: number;
  /** Text taken as typed, such as a recovery phrase: no autofill, capitalisation, autocorrect or spellcheck. */
  verbatim?: boolean;
  onInput: (value: string) => void;
}): JSX.Element {
  const off = (): 'off' | undefined => (props.verbatim === true ? 'off' : undefined);
  return (
    <div class={s['field']}>
      <label class={s['label']} for={props.id}>
        {props.label}
      </label>
      <textarea
        id={props.id}
        class={s['input']}
        data-testid={props.testId}
        rows={props.rows ?? 3}
        autocomplete={off()}
        autocapitalize={off()}
        autocorrect={off()}
        spellcheck={props.verbatim === true ? 'false' : undefined}
        value={props.value}
        onInput={event => {
          props.onInput(event.currentTarget.value);
        }}
      />
    </div>
  );
}
