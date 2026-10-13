// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './ErrorText.module.css';

/** A failure the user should see, announced as it appears. */
export function ErrorText(props: { testId: string; children: JSX.Element }): JSX.Element {
  return (
    <p class={s['error']} data-testid={props.testId} role="alert">
      {props.children}
    </p>
  );
}
