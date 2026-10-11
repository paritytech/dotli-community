// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './LinkButton.module.css';

/** An inline action that reads as a link, such as a jump to a related event. */
export function LinkButton(props: {
  testId?: string | undefined;
  title?: string | undefined;
  /** What it points at, as `data-value`. */
  value?: string | undefined;
  onClick: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      class={s['link']}
      data-testid={props.testId}
      data-value={props.value}
      title={props.title}
      onClick={() => {
        props.onClick();
      }}
    >
      {props.children}
    </button>
  );
}
