// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One tab of a browser profile runs the test wallet. Opening an app takes it
// automatically; a tab that lost it takes it back on the user's next
// interaction, never from background activity, so two tabs cannot bounce it.

const AUTO_TAKEOVER_KEY = "dotli:wallet-auto-takeover-at";
/** A second refusal this soon after an automatic takeover means it did not stick. */
export const AUTO_TAKEOVER_WINDOW_MS = 30_000;

/**
 * Whether a boot refused by another tab may take the wallet without asking.
 * Records the attempt, so the reload that follows cannot loop: if the wallet
 * is still busy right after, the manual page is shown instead.
 */
export function claimAutoTakeover(
  storage: Pick<Storage, "getItem" | "setItem">,
  now: number = Date.now(),
): boolean {
  try {
    const last = Number(storage.getItem(AUTO_TAKEOVER_KEY));
    if (last > 0 && now - last < AUTO_TAKEOVER_WINDOW_MS) {
      return false;
    }
    storage.setItem(AUTO_TAKEOVER_KEY, String(now));
    return true;
  } catch {
    // Without per-tab storage a failed takeover could reload forever.
    return false;
  }
}

/**
 * Call `resume` once on the next user interaction with this tab: a pointer or
 * key press in the shell, or focus moving into the app frame (the frame is
 * cross-origin, so its own events never reach this document).
 */
export function onNextInteraction(
  resume: () => void,
  win: Window = window,
): () => void {
  let done = false;
  const onBlur = (): void => {
    setTimeout(() => {
      if (win.document.activeElement?.tagName === "IFRAME") {
        fire();
      }
    }, 0);
  };
  const stop = (): void => {
    win.removeEventListener("pointerdown", fire, true);
    win.removeEventListener("keydown", fire, true);
    win.removeEventListener("blur", onBlur);
  };
  function fire(): void {
    if (done) {
      return;
    }
    done = true;
    stop();
    resume();
  }
  win.addEventListener("pointerdown", fire, true);
  win.addEventListener("keydown", fire, true);
  win.addEventListener("blur", onBlur);
  return stop;
}
