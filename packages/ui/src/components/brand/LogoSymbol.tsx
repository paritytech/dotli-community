// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// From the Polkadot Logo Guide's logo-symbol export. Paths from svgo --multipass --precision 2.

import type { JSX } from '@solidjs/web';

const WIDTH = 57.24;
const HEIGHT = 64.23;

export interface LogoSymbolProps {
  class?: JSX.ClassValue;
  testId?: string | undefined;
  /** In pixels. The width follows the symbol's proportions. */
  height?: number | undefined;
}

/** The Polkadot symbol in the current text color. Decorative, so hidden from assistive technology. */
export function LogoSymbol(props: LogoSymbolProps): JSX.Element {
  const height = (): number => props.height ?? HEIGHT;
  return (
    <svg
      class={props.class}
      data-testid={props.testId}
      width={(height() * WIDTH) / HEIGHT}
      height={height()}
      viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M3.26 13.73c-4.25 4.95-4.36 11.85-.24 15.39s10.92 2.4 15.18-2.57c4.25-4.95 4.37-11.85.24-15.39a8.7 8.7 0 0 0-5.77-2.05c-3.3 0-6.82 1.6-9.4 4.62M2.03 39.37c-3.2 3.8-1.81 10.24 3.1 14.4s11.52 4.44 14.72.64 1.8-10.24-3.1-14.4a13.4 13.4 0 0 0-8.47-3.31c-2.48 0-4.74.88-6.24 2.67M30.9 53.26c-5.76 1.83-9.74 5.54-8.88 8.3.87 2.75 6.26 3.5 12.03 1.68 5.77-1.83 9.75-5.54 8.89-8.3-.56-1.73-2.9-2.68-6-2.68-1.83 0-3.9.32-6.03 1M21.87 3.54c-1.19 3.44 2.6 7.87 8.46 9.92s11.59.91 12.78-2.52-2.59-7.88-8.46-9.92A18 18 0 0 0 28.93 0c-3.5 0-6.27 1.26-7.06 3.54m26.38 6.92c-1.7.69-1.3 5.65.9 11.07s5.34 9.27 7.04 8.59 1.3-5.64-.9-11.07c-2.02-5-4.86-8.66-6.62-8.66q-.21 0-.42.07m1.3 32.99c-2.41 5.24-3.25 10.01-1.86 10.65s4.48-3.09 6.9-8.33 3.25-10.01 1.87-10.65a1 1 0 0 0-.35-.07c-1.5 0-4.32 3.56-6.56 8.4" />
    </svg>
  );
}
