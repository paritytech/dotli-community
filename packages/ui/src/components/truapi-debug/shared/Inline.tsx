// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './Inline.module.css';

/** Children side by side on one line, such as an event's time, direction and method. */
export function Inline(props: { children: JSX.Element }): JSX.Element {
  return <div class={s['inline']}>{props.children}</div>;
}
