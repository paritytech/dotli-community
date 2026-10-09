// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './Callout.module.css';

/** A highlighted line of prose, such as what an event means. */
export function Callout(props: { testId: string; children: JSX.Element }): JSX.Element {
  return (
    <div class={s['callout']} data-testid={props.testId}>
      {props.children}
    </div>
  );
}
