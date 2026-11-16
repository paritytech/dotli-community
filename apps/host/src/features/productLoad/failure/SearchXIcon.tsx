// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { IconProps } from '@dotli/ui/icons';

/** A magnifier with a cross, for a search that found nothing. */
export function SearchXIcon(props: IconProps): JSX.Element {
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
      <path d="M3 11a8 8 0 1 0 16 0 8 8 0 1 0-16 0m18 10-4.3-4.3M13.5 8.5l-5 5m0-5 5 5" />
    </svg>
  );
}
