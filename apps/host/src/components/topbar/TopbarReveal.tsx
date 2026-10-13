// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { onSettled, Show, untrack, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import s from './TopbarReveal.module.css';

/** The always-reachable reveal control, one Tab past the app frame. */
const TOPBAR_REVEAL_BUTTON_ID = 'topbar-reveal';

/** What the bar's auto-hide does for its ways back. */
export interface RevealActions {
  /** Hands over the reveal button, so focus on it counts as the bar's. Returns the release. */
  registerRevealButton: (el: HTMLElement) => () => void;
  reveal: () => void;
  revealAndFocus: () => void;
}

export interface TopbarRevealProps {
  /** The bar auto-hides, so its ways back show. */
  autoHide: Accessor<boolean>;
  /** The reveal shortcut, which the button advertises as the bar does. */
  shortcut: string;
  actions: RevealActions;
}

/**
 * The auto-hiding topbar's ways back.
 *
 * - A skip-link style button: keys pressed inside the cross-origin frame never reach this document, so a
 *   shortcut alone cannot recover the bar. One forward Tab out of the dApp reaches it instead.
 * - An invisible strip at the top, so hover reaches the host document over the product frame.
 */
export function TopbarReveal(props: TopbarRevealProps): JSX.Element {
  let button: HTMLButtonElement | undefined;
  const { registerRevealButton, reveal, revealAndFocus } = untrack(() => props.actions);
  onSettled(() => (button === undefined ? undefined : registerRevealButton(button)));

  return (
    <>
      <button
        ref={el => {
          button = el;
        }}
        onFocus={reveal}
        onClick={revealAndFocus}
        type="button"
        id={TOPBAR_REVEAL_BUTTON_ID}
        class={s['reveal']}
        aria-keyshortcuts={props.shortcut}
        aria-controls="topbar"
        hidden={!props.autoHide()}
      >
        Show browser bar
      </button>
      <Show when={props.autoHide()}>
        <div class={s['hit']} onMouseEnter={reveal} aria-hidden="true" />
      </Show>
    </>
  );
}
