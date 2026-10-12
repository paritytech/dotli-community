// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './Callout.module.css';

/** A highlighted line of prose, such as what an event means, or a `warn` the reader must not miss. */
export function Callout(props: { testId: string; tone?: 'info' | 'warn'; children: JSX.Element }): JSX.Element {
  return (
    <div class={[s['callout'], props.tone === 'warn' && s['warn']]} data-testid={props.testId}>
      {props.children}
    </div>
  );
}
