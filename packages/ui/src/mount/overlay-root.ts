// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

const OVERLAY_ROOT_ID = 'overlay-root';

/**
 * The container for toasts and modals. Created on first use as the last child
 * of `body`, so overlays stack above the shell and `#app`.
 */
export function ensureOverlayRoot(): HTMLElement {
  const existing = document.getElementById(OVERLAY_ROOT_ID);
  if (existing !== null) {
    return existing;
  }
  const el = document.createElement('div');
  el.id = OVERLAY_ROOT_ID;
  document.body.appendChild(el);
  return el;
}
