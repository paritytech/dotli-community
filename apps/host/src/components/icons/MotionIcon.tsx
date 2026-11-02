// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { IconProps } from '@dotli/ui/icons';

/** A phone tilting between two motion arcs, for the motion sensors permission. */
export function MotionIcon(props: IconProps): JSX.Element {
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
      <path d="M9 4h6a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM11 17h2M4 8a8 8 0 0 0 0 8M20 8a8 8 0 0 1 0 8" />
    </svg>
  );
}
