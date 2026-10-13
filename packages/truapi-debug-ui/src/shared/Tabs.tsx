// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './Tabs.module.css';

export interface TabOption<T extends string> {
  value: T;
  label: string;
}

/** A tab strip. Each tab carries its value as `data-value`. */
export function Tabs<T extends string>(props: {
  tabs: readonly TabOption<T>[];
  selected: T;
  onSelect: (value: T) => void;
  /** `primary` for the panel's top-level tabs, `secondary` for tabs inside one. */
  variant: 'primary' | 'secondary';
  testId: string;
  tabTestId: string;
  hidden?: boolean;
  class?: string | undefined;
}): JSX.Element {
  return (
    <div class={[s['tabs'], props.class]} data-testid={props.testId} role="tablist" hidden={props.hidden}>
      <For each={props.tabs}>
        {tab => (
          <button
            class={[s['tab'], s[props.variant]]}
            data-testid={props.tabTestId}
            data-value={tab.value}
            role="tab"
            aria-selected={props.selected === tab.value ? 'true' : 'false'}
            type="button"
            onClick={() => {
              props.onSelect(tab.value);
            }}
          >
            {tab.label}
          </button>
        )}
      </For>
    </div>
  );
}
