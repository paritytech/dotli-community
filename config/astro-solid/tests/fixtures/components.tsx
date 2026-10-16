// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal } from 'solid-js';
import type { JSX } from '@solidjs/web';

export function Counter(props: { start: number; children?: JSX.Element }): JSX.Element {
  // eslint-disable-next-line solid/reactivity -- the start value seeds the count once.
  const [count, setCount] = createSignal(props.start);
  return (
    <div class="counter">
      {props.children}
      <button
        type="button"
        onClick={() => {
          setCount(n => n + 1);
        }}
      >
        {count()}
      </button>
    </div>
  );
}

export function Label(props: { text: string }): JSX.Element {
  return <span class="label">{props.text}</span>;
}
