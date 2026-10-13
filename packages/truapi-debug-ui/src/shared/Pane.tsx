// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './Pane.module.css';

/**
 * A scrolling area of the panel body, such as a tab's content. Sets no display, so `hidden` hides it.
 * A named region that takes focus, so a keyboard can scroll it.
 */
export function Pane(props: {
  testId: string;
  /** The region's name. */
  label: string;
  hidden?: boolean;
  /** Content that is not a full-bleed list or chart. */
  padded?: boolean;
  /** Draws no focus ring, for a view that answers keys and shows its own selection. */
  ownFocus?: boolean;
  class?: string | undefined;
  ref?: (el: HTMLDivElement) => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div
      class={[s['pane'], props.padded === true && s['padded'], props.ownFocus === true && s['ownFocus'], props.class]}
      data-testid={props.testId}
      role="region"
      aria-label={props.label}
      hidden={props.hidden}
      tabindex="0"
      ref={el => {
        props.ref?.(el);
      }}
    >
      {props.children}
    </div>
  );
}
