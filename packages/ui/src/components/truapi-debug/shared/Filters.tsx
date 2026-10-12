// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The panel's filter controls. Each control carries its value as `data-value`, and the caller owns the filter state.

import { For } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Bar } from './Bar.js';
import s from './Filters.module.css';

export function FilterBar(props: {
  testId: string;
  hidden: boolean;
  class?: string | undefined;
  children: JSX.Element;
}): JSX.Element {
  return (
    <Bar testId={props.testId} hidden={props.hidden} wrap class={props.class}>
      {props.children}
    </Bar>
  );
}

/** A labelled run of controls in the bar. */
export function FilterGroup(props: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div class={s['group']}>
      <span class={s['label']}>{props.label}</span>
      {props.children}
    </div>
  );
}

export function FilterCheck(props: {
  testId: string;
  value: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label class={s['check']}>
      <input
        type="checkbox"
        class={s['checkbox']}
        data-testid={props.testId}
        data-value={props.value}
        checked={props.checked}
        onChange={e => {
          props.onChange(e.currentTarget.checked);
        }}
      />{' '}
      {props.label}
    </label>
  );
}

export interface FilterChip<T extends string> {
  value: T;
  label: string;
}

/** Chips picking one value. Keyed by value, so a list that changes under traffic keeps its nodes and clicks land. */
export function FilterChips<T extends string>(props: {
  testId: string;
  chips: readonly FilterChip<T>[];
  selected: T;
  onSelect: (value: T) => void;
}): JSX.Element {
  return (
    <div class={s['chips']}>
      <For each={props.chips} keyed={chip => chip.value}>
        {chip => (
          <button
            type="button"
            class={s['chip']}
            data-testid={props.testId}
            data-value={chip().value}
            data-active={props.selected === chip().value ? '' : undefined}
            onClick={() => {
              props.onSelect(chip().value);
            }}
          >
            {chip().label}
          </button>
        )}
      </For>
    </div>
  );
}

export function FilterInput(props: {
  testId: string;
  placeholder: string;
  title: string;
  invalid: boolean;
  onInput: (value: string) => void;
}): JSX.Element {
  return (
    <input
      class={s['input']}
      data-testid={props.testId}
      aria-invalid={props.invalid ? 'true' : undefined}
      type="search"
      placeholder={props.placeholder}
      title={props.title}
      spellcheck="false"
      autocomplete="off"
      onInput={e => {
        props.onInput(e.currentTarget.value);
      }}
    />
  );
}
