// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './Chip.module.css';

/** `default` a quiet fill, `ok` a green tint, `mono` a code value (network, host). */
export type ChipTone = 'default' | 'ok' | 'mono';

export function Chip(props: {
  tone?: ChipTone;
  class?: string | undefined;
  testId?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <span class={[s['chip'], props.class]} data-tone={props.tone ?? 'default'} data-testid={props.testId}>
      {props.children}
    </span>
  );
}
