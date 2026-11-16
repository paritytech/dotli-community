// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the sandbox draws itself: its toasts and dialogs, the error page, the retry screen and the password dialog.
// Loaded on demand the first time something needs it, so a product that loads never fetches it.

import { ensureOverlayRoot, mountRoot, Overlays } from '@dotli/ui';

export { showError } from '@dotli/ui';
export { createPasswordPromptView } from './createPasswordPromptView.js';
export { showRetryScreen } from './showRetryScreen.js';

/** Mounts the toasts and dialogs, in a container a full-page screen keeps. */
export function mountOverlays(): void {
  const root = ensureOverlayRoot();
  root.dataset['overlays'] = '';
  mountRoot({ name: 'overlays', container: root, view: () => <Overlays /> });
}
