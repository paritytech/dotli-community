// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { IconProps } from './icon-props.js';

/** The Polkadot mark as six dots, for the Polkadot App. */
export function PolkadotIcon(props: IconProps): JSX.Element {
  return (
    <svg
      class={props.class}
      data-testid={props.testId}
      width={props.size ?? 20}
      height={props.size ?? 20}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <ellipse cx="12" cy="3.6" rx="3.3" ry="2.1" />
      <ellipse cx="12" cy="20.4" rx="3.3" ry="2.1" />
      <ellipse cx="19.3" cy="7.8" rx="3.3" ry="2.1" transform="rotate(60 19.3 7.8)" />
      <ellipse cx="19.3" cy="16.2" rx="3.3" ry="2.1" transform="rotate(-60 19.3 16.2)" />
      <ellipse cx="4.7" cy="16.2" rx="3.3" ry="2.1" transform="rotate(60 4.7 16.2)" />
      <ellipse cx="4.7" cy="7.8" rx="3.3" ry="2.1" transform="rotate(-60 4.7 7.8)" />
    </svg>
  );
}
