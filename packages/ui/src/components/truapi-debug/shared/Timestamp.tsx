// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { formatTime } from '@dotli/truapi-debug';
import s from './Timestamp.module.css';

/** When an event arrived, to the millisecond. */
export function Timestamp(props: { at: number }): JSX.Element {
  return (
    <span class={s['time']} data-testid="td-time">
      {formatTime(props.at)}
    </span>
  );
}
