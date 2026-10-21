// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './Note.module.css';

/** A quiet remark beside the content, such as why only part of it shows. */
export function Note(props: { testId?: string | undefined; children: JSX.Element }): JSX.Element {
  return (
    <div class={s['note']} data-testid={props.testId}>
      {props.children}
    </div>
  );
}
