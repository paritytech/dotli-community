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

/** Where each key moves the focus from option `index` of `count`. */
const FOCUS_KEYS: Readonly<Record<string, (index: number, count: number) => number>> = {
  ArrowRight: (index, count) => (index + 1) % count,
  ArrowDown: (index, count) => (index + 1) % count,
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  ArrowUp: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_index, count) => count - 1,
};

/**
 * One choice out of a few, as pressed buttons in a sunken track. It is one
 * Tab stop, on the pressed option (the first while none is): the arrow keys,
 * Home and End move the focus between the options without picking, and a
 * click, Enter or Space picks the focused one.
 */
export function SegmentedControl<V extends string>(props: SegmentedControlProps<V>): JSX.Element {
  const tabStop = (): number =>
    Math.max(
      props.options.findIndex(option => option.value === props.value),
      0,
    );

  const onKeyDown = (e: KeyboardEvent): void => {
    const move = FOCUS_KEYS[e.key];
    const buttons = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>(':scope > button'));
    const index = buttons.indexOf(e.target as HTMLButtonElement);
    if (move === undefined || index < 0) {
      return;
    }
    e.preventDefault();
    buttons[move(index, buttons.length)]?.focus();
  };

  return (
    <div
      role="group"
      aria-label={props.label}
      class={[s['seg'], props.class]}
      data-layout={props.layout ?? 'inline'}
      data-testid={props.testId}
      onKeyDown={onKeyDown}
    >
      <For each={props.options}>
        {(option, index) => (
          <button
            type="button"
            class={s['option']}
            aria-pressed={option.value === props.value ? 'true' : 'false'}
            tabindex={index() === tabStop() ? 0 : -1}
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
