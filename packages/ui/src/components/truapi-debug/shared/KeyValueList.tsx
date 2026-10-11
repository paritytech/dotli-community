// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The panel's label and value lists: diagnostics, the wallet and the detail pane's fields.

import type { JSX } from '@solidjs/web';
import s from './KeyValueList.module.css';

export function KeyValueList(props: { testId?: string | undefined; children: JSX.Element }): JSX.Element {
  return (
    <dl class={s['list']} data-testid={props.testId}>
      {props.children}
    </dl>
  );
}

export function KeyValue(props: { name: string; testId?: string | undefined; children: JSX.Element }): JSX.Element {
  return (
    <div class={s['row']} data-testid={props.testId}>
      <dt class={s['name']}>{props.name}</dt>
      <dd class={s['value']}>{props.children}</dd>
    </div>
  );
}

/** A title over a group of lists. */
export function ListHeading(props: { children: JSX.Element }): JSX.Element {
  return <h3 class={s['heading']}>{props.children}</h3>;
}
