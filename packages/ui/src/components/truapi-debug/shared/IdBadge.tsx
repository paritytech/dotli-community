// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { ridColor } from '@dotli/truapi-debug';
import s from './IdBadge.module.css';

/** An id's first characters, tinted by a hash of it, so everything of one request or flow shares a colour. */
export function IdBadge(props: { id: string; testId: string; title?: string | undefined }): JSX.Element {
  return (
    <span class={s['badge']} data-testid={props.testId} style={{ color: ridColor(props.id) }} title={props.title}>
      {props.id.slice(0, 6)}
    </span>
  );
}

/** The badge followed by the whole id. */
export function IdValue(props: { id: string }): JSX.Element {
  return (
    <>
      <IdBadge id={props.id} testId="td-id-badge" /> <code>{props.id}</code>
    </>
  );
}
