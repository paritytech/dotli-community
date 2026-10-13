// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { IconProps } from '@dotli/ui/icons';

/** A microphone, for the microphone permission. */
export function MicrophoneIcon(props: IconProps): JSX.Element {
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
      <path d="M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0zm10 5v2a7 7 0 0 1-14 0v-2m7 9v3" />
    </svg>
  );
}
