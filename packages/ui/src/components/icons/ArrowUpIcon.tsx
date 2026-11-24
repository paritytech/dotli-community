// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { IconProps } from './iconProps.js';

/** An arrow pointing up, for sending a message. */
export function ArrowUpIcon(props: IconProps): JSX.Element {
  return (
    <svg
      class={props.class}
      data-testid={props.testId}
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 19V5m-7 7 7-7 7 7" />
    </svg>
  );
}
