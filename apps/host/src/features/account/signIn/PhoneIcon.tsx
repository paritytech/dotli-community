// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { IconProps } from '@dotli/ui/icons';

/** A phone, for a step that waits on Polkadot App, where a check would read as already done. */
export function PhoneIcon(props: IconProps): JSX.Element {
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
      <rect x="6" y="2" width="12" height="20" rx="2.5" />
      <path d="M11 18h2" />
    </svg>
  );
}
