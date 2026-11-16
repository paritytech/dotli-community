// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { createOverflow } from '../createOverflow.js';
import { AlertTriangleIcon } from '../icons/AlertTriangleIcon.js';
import s from './Field.module.css';

/** A label over its value, for the review fields of a signing or permission prompt. */
export function Field(props: {
  label: string;
  value: string;
  /** Hashes and call data, in a box that scrolls once the value outgrows it. */
  mono?: boolean;
  /** A value the user must not miss, such as an unprotected signature. A warning glyph leads it. */
  warning?: boolean;
  class?: string | undefined;
  testId?: string;
  labelTestId?: string;
  valueTestId?: string;
}): JSX.Element {
  const overflow = createOverflow();
  // Safari never makes a scroller focusable, so an overflowing value takes the tab stop itself.
  const scrolls = (): boolean => props.mono === true && overflow.overflows();
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
        ref={overflow.ref}
        class={s['value']}
        data-testid={props.valueTestId}
        data-scrolls={scrolls() ? '' : undefined}
        tabindex={scrolls() ? 0 : undefined}
        role={scrolls() ? 'region' : undefined}
        aria-label={scrolls() ? props.label : undefined}
      >
        {props.warning === true ? <AlertTriangleIcon class={s['warnIcon']} /> : null}
        {props.value}
      </span>
    </div>
  );
}
