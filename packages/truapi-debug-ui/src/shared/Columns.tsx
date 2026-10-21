// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './Columns.module.css';

/** Columns that sit side by side when the pane is wide enough and wrap under each other when not. */
export function Columns(props: { children: JSX.Element }): JSX.Element {
  return <div class={s['columns']}>{props.children}</div>;
}

export function Column(props: { testId?: string | undefined; children: JSX.Element }): JSX.Element {
  return (
    <section class={s['column']} data-testid={props.testId}>
      {props.children}
    </section>
  );
}
