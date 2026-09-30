// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { onSettled, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { topbarStore } from '../../state/topbar.js';
import {
  registerTopbarRevealButton,
  revealTopbar,
  revealTopbarAndFocus,
  TOPBAR_REVEAL_BUTTON_ID,
  TOPBAR_REVEAL_SHORTCUT,
} from '../../topbar-autohide.js';
import { useStore } from '../use-store.js';

/**
 * The auto-hiding topbar's ways back (see topbar-autohide.ts), an island of
 * the host page right after `#app`, while the auto-hide is on:
 *
 * - A skip-link style control, so one forward Tab out of the dApp reaches
 *   the bar: keys pressed inside the cross-origin frame never reach this
 *   document, which rules out a shortcut-only recovery. Its focus alone
 *   reveals the bar, so a passing Tab already shows what it does, and
 *   activating it hands the focus to the bar's first control.
 * - An invisible strip at the very top, so hover reaches the host document
 *   even when the pointer is over the product frame.
 */
export function TopbarReveal(): JSX.Element {
  let button: HTMLButtonElement | undefined;
  const autoHide = useStore(topbarStore, state => state.autoHide);
  onSettled(() => (button === undefined ? undefined : registerTopbarRevealButton(button)));

  return (
    <>
      <button
        ref={el => {
          button = el;
          el.addEventListener('focus', revealTopbar);
          el.addEventListener('click', revealTopbarAndFocus);
        }}
        type="button"
        id={TOPBAR_REVEAL_BUTTON_ID}
        class="topbar-reveal"
        aria-keyshortcuts={TOPBAR_REVEAL_SHORTCUT}
        aria-controls="topbar"
        hidden={!autoHide()}
      >
        Show browser bar
      </button>
      <Show when={autoHide()}>
        <div
          ref={el => {
            el.addEventListener('mouseenter', revealTopbar);
          }}
          aria-hidden="true"
          style={{ position: 'fixed', top: '0', left: '0', right: '0', height: '6px', 'z-index': '999' }}
        />
      </Show>
    </>
  );
}
