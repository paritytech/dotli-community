// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './Announce.module.css';

/** Text a screen reader speaks when it changes, kept off screen because the control already shows it. */
export function Announce(props: { testId?: string | undefined; children: JSX.Element }): JSX.Element {
  return (
    <span class={s['announce']} role="status" data-testid={props.testId}>
      {props.children}
    </span>
  );
}
