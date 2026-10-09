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
  /** Read aloud in place of the text, for a value that needs its subject. */
  label?: string | undefined;
  /** Something is wrong with the value, such as a count of zero that should not be. */
  alert?: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <span
      class={[s['chip'], props.class]}
      data-tone={props.tone ?? 'default'}
      data-alert={props.alert === true ? '' : undefined}
      data-testid={props.testId}
      aria-label={props.label}
    >
      {props.children}
    </span>
  );
}
