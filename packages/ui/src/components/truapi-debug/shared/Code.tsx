// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './Code.module.css';

/** A value that is code, such as a hash or a method name. */
export function Code(props: { children: string }): JSX.Element {
  return <code class={s['code']}>{props.children}</code>;
}
