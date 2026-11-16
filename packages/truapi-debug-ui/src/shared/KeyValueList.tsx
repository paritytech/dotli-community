// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The panel's label and value lists: diagnostics, the wallet and the detail pane's fields.

import type { JSX } from '@solidjs/web';
import s from './KeyValueList.module.css';

export function KeyValueList(props: {
  testId?: string | undefined;
  class?: string | undefined;
  children: JSX.Element;
}): JSX.Element {
  return (
    <dl class={[s['list'], props.class]} data-testid={props.testId}>
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

/** Headed lists that share one label column, so their values line up. */
export function KeyValueGroup(props: {
  testId?: string | undefined;
  /** The label column's least width, in characters, for labels that run long, so the values hold their place. */
  keyWidth?: number | undefined;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div
      class={s['group']}
      data-testid={props.testId}
      style={props.keyWidth === undefined ? undefined : { '--td-key-width': `${String(props.keyWidth)}ch` }}
    >
      {props.children}
    </div>
  );
}
