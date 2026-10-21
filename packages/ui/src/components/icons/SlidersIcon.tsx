// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { IconProps } from './icon-props.js';

/** Two sliders, for settings. */
export function SlidersIcon(props: IconProps): JSX.Element {
  return (
    <svg
      class={props.class}
      data-testid={props.testId}
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M20 7h-9m3 10H4M4 7a3 3 0 1 0 6 0 3 3 0 1 0-6 0m10 10a3 3 0 1 0 6 0 3 3 0 1 0-6 0" />
    </svg>
  );
}
