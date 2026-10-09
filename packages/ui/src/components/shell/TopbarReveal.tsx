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
import s from './TopbarReveal.module.css';

/**
 * The auto-hiding topbar's ways back.
 *
 * - A skip-link style button: keys pressed inside the cross-origin frame never reach this document, so a
 *   shortcut alone cannot recover the bar. One forward Tab out of the dApp reaches it instead.
 * - An invisible strip at the top, so hover reaches the host document over the product frame.
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
        }}
        onFocus={revealTopbar}
        onClick={revealTopbarAndFocus}
        type="button"
        id={TOPBAR_REVEAL_BUTTON_ID}
        class={s['reveal']}
        aria-keyshortcuts={TOPBAR_REVEAL_SHORTCUT}
        aria-controls="topbar"
        hidden={!autoHide()}
      >
        Show browser bar
      </button>
      <Show when={autoHide()}>
        <div class={s['hit']} onMouseEnter={revealTopbar} aria-hidden="true" />
      </Show>
    </>
  );
}
