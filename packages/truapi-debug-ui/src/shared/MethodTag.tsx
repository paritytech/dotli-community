// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './MethodTag.module.css';

/** A TrUAPI method or a system event name, coloured by its kind, or as a failure when its call failed. */
export function MethodTag(props: { kind: string; failed?: boolean; children: JSX.Element }): JSX.Element {
  return (
    <span
      class={s['tag']}
      data-testid="td-tag"
      data-kind={props.kind}
      data-failed={props.failed === true ? '' : undefined}
    >
      {props.children}
    </span>
  );
}
