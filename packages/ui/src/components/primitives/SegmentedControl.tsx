// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For } from 'solid-js';
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
  class?: string | undefined;
  testId?: string;
}

const FOCUS_KEYS: Readonly<Record<string, (index: number, count: number) => number>> = {
  ArrowRight: (index, count) => (index + 1) % count,
  ArrowDown: (index, count) => (index + 1) % count,
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  ArrowUp: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_index, count) => count - 1,
};

/**
 * One choice out of a few, as pressed buttons in a sunken track. It is one Tab stop, and the
 * arrow keys, Home and End move the focus without picking.
 */
export function SegmentedControl<V extends string>(props: SegmentedControlProps<V>): JSX.Element {
  // Without it, Tab from an arrow-focused option stops on the pressed one before leaving.
  const [focused, setFocused] = createSignal<number | null>(null);
  const tabStop = (): number =>
    focused() ??
    Math.max(
      props.options.findIndex(option => option.value === props.value),
      0,
    );

  const buttonsOf = (group: HTMLElement): HTMLButtonElement[] =>
    Array.from(group.querySelectorAll<HTMLButtonElement>(':scope > button'));

  const onFocusIn = (e: FocusEvent): void => {
    const index = buttonsOf(e.currentTarget as HTMLElement).indexOf(e.target as HTMLButtonElement);
    setFocused(index < 0 ? null : index);
  };

  const onFocusOut = (e: FocusEvent): void => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) {
      setFocused(null);
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    const move = FOCUS_KEYS[e.key];
    const buttons = buttonsOf(e.currentTarget as HTMLElement);
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
      data-testid={props.testId}
      onKeyDown={onKeyDown}
      onFocusIn={onFocusIn}
      onFocusOut={onFocusOut}
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
