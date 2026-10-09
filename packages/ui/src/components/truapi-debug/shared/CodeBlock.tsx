// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './CodeBlock.module.css';

/** Preformatted text, such as a payload or a file. */
export function CodeBlock(props: {
  testId?: string | undefined;
  class?: string | undefined;
  children: string;
}): JSX.Element {
  return (
    <pre class={[s['block'], props.class]} data-testid={props.testId}>
      {props.children}
    </pre>
  );
}
