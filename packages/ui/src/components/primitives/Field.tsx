// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onSettled } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './Field.module.css';

/** A label over its value, for the review fields of a signing or permission prompt. */
export function Field(props: {
  label: string;
  value: string;
  /** Hashes and call data, in a box that scrolls once the value outgrows it. */
  mono?: boolean;
  /** A value the user must not miss, such as an unprotected signature. */
  warning?: boolean;
  class?: string | undefined;
  testId?: string;
  labelTestId?: string;
  valueTestId?: string;
}): JSX.Element {
  let value: HTMLSpanElement | undefined;
  const [overflows, setOverflows] = createSignal(false);
  // Safari never makes a scroller focusable, so an overflowing value takes the tab stop itself.
  const measure = (): void => {
    setOverflows(value !== undefined && value.scrollHeight > value.clientHeight);
  };
  onSettled(() => {
    if (props.mono !== true) {
      return;
    }
    measure();
    if (value === undefined || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(value);
    return () => {
      observer.disconnect();
    };
  });
  const scrolls = (): boolean => props.mono === true && overflows();
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
        ref={el => {
          value = el;
        }}
        class={s['value']}
        data-testid={props.valueTestId}
        tabindex={scrolls() ? 0 : undefined}
        role={scrolls() ? 'region' : undefined}
        aria-label={scrolls() ? props.label : undefined}
      >
        {props.value}
      </span>
    </div>
  );
}
