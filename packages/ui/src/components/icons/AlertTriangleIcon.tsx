// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { IconProps } from './icon-props.js';

/** A warning triangle with an exclamation mark. */
export function AlertTriangleIcon(props: IconProps & { strokeWidth?: string | undefined }): JSX.Element {
  return (
    <svg
      class={props.class}
      data-testid={props.testId}
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={props.strokeWidth ?? '1.75'}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      // @ts-expect-error -- not in Solid's SVG types, but hides the icon from focus
      focusable="false"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4m0 4h.01" />
    </svg>
  );
}
