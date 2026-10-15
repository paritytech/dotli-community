// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { IconProps } from './icon-props.js';

/** A solid triangle pointing left, for a message that came from the product. */
export function IncomingIcon(props: IconProps): JSX.Element {
  return (
    <svg
      data-testid={props.testId}
      width={props.size ?? 12}
      height={props.size ?? 12}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M17 4v16L4 12z" />
    </svg>
  );
}
