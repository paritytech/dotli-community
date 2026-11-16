// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './Callout.module.css';

/** A highlighted line of prose, such as what an event means, a `warn` the reader must not miss or a `danger` failure. */
export function Callout(props: {
  testId: string;
  tone?: 'info' | 'warn' | 'danger';
  /** Announced as it appears, for a failure the user should hear about. */
  alert?: boolean;
  class?: string | undefined;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div
      class={[s['callout'], props.tone === 'warn' && s['warn'], props.tone === 'danger' && s['danger'], props.class]}
      data-testid={props.testId}
      role={props.alert === true ? 'alert' : undefined}
    >
      {props.children}
    </div>
  );
}
