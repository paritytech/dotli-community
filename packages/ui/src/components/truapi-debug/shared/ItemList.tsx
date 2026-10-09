// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The panel's lists of rows to pick from: the TrUAPI events and the archive's files.

import type { JSX } from '@solidjs/web';
import s from './ItemList.module.css';

/** The list's own classes, for the event list, which draws its rows with a helper to stay fast at capacity. */
export const itemListClass = s['items'];
export const itemClass = s['item'];

export function ItemList(props: { children: JSX.Element }): JSX.Element {
  return <ul class={s['items']}>{props.children}</ul>;
}

export function Item(props: {
  testId: string;
  /** What the row stands for, as `data-value`. */
  value: string;
  selected: boolean;
  title?: string | undefined;
  onSelect: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <li>
      <button
        type="button"
        class={[s['button'], s['item']]}
        data-testid={props.testId}
        data-value={props.value}
        data-selection={props.selected ? 'selected' : undefined}
        title={props.title}
        onClick={() => {
          props.onSelect();
        }}
      >
        {props.children}
      </button>
    </li>
  );
}
