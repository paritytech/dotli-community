// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './Pane.module.css';

/** A scrolling area of the panel body, such as a tab's content. Sets no display, so `hidden` hides it. */
export function Pane(props: {
  testId: string;
  hidden?: boolean;
  /** Content that is not a full-bleed list or chart. */
  padded?: boolean;
  /** Takes keyboard focus, for a view that answers keys. */
  focusable?: boolean;
  class?: string | undefined;
  ref?: (el: HTMLDivElement) => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div
      class={[s['pane'], props.padded === true && s['padded'], props.focusable === true && s['focusable'], props.class]}
      data-testid={props.testId}
      hidden={props.hidden}
      tabindex={props.focusable === true ? '0' : undefined}
      ref={el => {
        props.ref?.(el);
      }}
    >
      {props.children}
    </div>
  );
}
