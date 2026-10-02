// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Key/value lists of the TrUAPI debug panel detail pane.

import type { JSX } from '@solidjs/web';
import { ridColor } from '@dotli/truapi-debug';
import s from './Fields.module.css';

export function Fields(props: { testId: string; chain?: boolean; children: JSX.Element }): JSX.Element {
  return (
    <dl class={[s['fields'], props.chain === true && s['chain']]} data-testid={props.testId}>
      {props.children}
    </dl>
  );
}

export function Field(props: { name: string; children: JSX.Element }): JSX.Element {
  return (
    <>
      <dt class={s['name']}>{props.name}</dt>
      <dd class={s['value']}>{props.children}</dd>
    </>
  );
}

/** A requestId or flowId: its short coloured badge, then the whole id. */
export function IdValue(props: { id: string }): JSX.Element {
  return (
    <>
      <span class={s['rid']} data-testid="td-id-badge" style={{ color: ridColor(props.id) }}>
        {props.id.slice(0, 6)}
      </span>{' '}
      <code>{props.id}</code>
    </>
  );
}

/** An id or hash among the chain annotations. */
export function ChainCode(props: { children: string }): JSX.Element {
  return <code class={s['code']}>{props.children}</code>;
}
