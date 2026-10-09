// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './Latency.module.css';

/** Time since the first event of the group, such as a response's round trip. Nothing for the first event. */
export function Latency(props: { text: string | null }): JSX.Element {
  return (
    <Show when={props.text}>
      {text => (
        <span class={s['latency']} data-testid="td-latency">
          {text()}
        </span>
      )}
    </Show>
  );
}
