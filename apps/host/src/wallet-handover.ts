// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A tab that lost the test wallet to another tab takes it back on the user's
// next interaction, never from background activity, so two tabs cannot bounce
// the wallet between them.

/**
 * Call `resume` once on the next user interaction with this tab: a pointer or
 * key press in the shell, or focus moving into the app frame (the frame is
 * cross-origin, so its own events never reach this document).
 *
 * Focus still inside the app frame would never move into it again, so a click
 * there would go unnoticed; hand focus back to the shell first.
 */
export function onNextInteraction(resume: () => void, win: Window = window): () => void {
  let done = false;
  const focused = win.document.activeElement;
  if (focused instanceof HTMLIFrameElement) {
    focused.blur();
  }
  const onBlur = (): void => {
    setTimeout(() => {
      if (win.document.activeElement?.tagName === 'IFRAME') {
        fire();
      }
    }, 0);
  };
  const stop = (): void => {
    win.removeEventListener('pointerdown', fire, true);
    win.removeEventListener('keydown', fire, true);
    win.removeEventListener('blur', onBlur);
  };
  function fire(): void {
    if (done) {
      return;
    }
    done = true;
    stop();
    resume();
  }
  win.addEventListener('pointerdown', fire, true);
  win.addEventListener('keydown', fire, true);
  win.addEventListener('blur', onBlur);
  return stop;
}
