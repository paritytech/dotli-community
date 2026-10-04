// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './SegmentedControl.module.css';

export interface SegmentOption<V extends string> {
  value: V;
  label: string;
  icon?: JSX.Element;
  testId?: string;
}

export interface SegmentedControlProps<V extends string> {
  /** The group's accessible name. */
  label: string;
  options: readonly SegmentOption<V>[];
  value: V;
  /** Called with a newly picked value, never with the current one. */
  onChange: (value: V) => void;
  /** `tiles`: icon over label in a grid of equal tiles. */
  layout?: 'inline' | 'tiles';
  class?: string | undefined;
  testId?: string;
}

/** One choice out of a few, as pressed buttons in a sunken track. */
export function SegmentedControl<V extends string>(props: SegmentedControlProps<V>): JSX.Element {
  return (
    <div
      role="group"
      aria-label={props.label}
      class={[s['seg'], props.class]}
      data-layout={props.layout ?? 'inline'}
      data-testid={props.testId}
    >
      <For each={props.options}>
        {option => (
          <button
            type="button"
            class={s['option']}
            aria-pressed={option.value === props.value ? 'true' : 'false'}
            onClick={() => {
              if (option.value !== props.value) {
                props.onChange(option.value);
              }
            }}
            data-testid={option.testId}
          >
            {option.icon}
            {option.label}
          </button>
        )}
      </For>
    </div>
  );
}
