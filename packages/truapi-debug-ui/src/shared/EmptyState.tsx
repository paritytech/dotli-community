// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './EmptyState.module.css';

/** Says why a view has nothing to show. */
export function EmptyState(props: { testId: string; class?: string | undefined; children: JSX.Element }): JSX.Element {
  return (
    <div class={[s['empty'], props.class]} data-testid={props.testId}>
      {props.children}
    </div>
  );
}
