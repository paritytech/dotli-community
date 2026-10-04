// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './Field.module.css';

/** A label over its value, for the review fields of a signing or permission prompt. */
export function Field(props: {
  label: string;
  value: string;
  /** Hashes and call data. */
  mono?: boolean;
  /** A value the user must not miss, such as an unprotected signature. */
  warning?: boolean;
  class?: string | undefined;
  testId?: string;
  labelTestId?: string;
  valueTestId?: string;
}): JSX.Element {
  return (
    <div
      class={[s['field'], props.class]}
      data-mono={props.mono === true ? '' : undefined}
      data-warning={props.warning === true ? '' : undefined}
      data-testid={props.testId}
    >
      <span class={s['label']} data-testid={props.labelTestId}>
        {props.label}
      </span>
      <span
        class={s['value']}
        data-testid={props.valueTestId}
        tabindex={props.mono === true ? 0 : undefined}
        role={props.mono === true ? 'region' : undefined}
        aria-label={props.mono === true ? props.label : undefined}
      >
        {props.value}
      </span>
    </div>
  );
}
