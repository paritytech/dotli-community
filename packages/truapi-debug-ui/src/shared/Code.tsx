// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './Code.module.css';

/** A value that is code, such as a hash or a version. */
export function Code(props: { muted?: boolean; testId?: string | undefined; children: string }): JSX.Element {
  return (
    <code class={[s['code'], props.muted === true && s['muted']]} data-testid={props.testId}>
      {props.children}
    </code>
  );
}
