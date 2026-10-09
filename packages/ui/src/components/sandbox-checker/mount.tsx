// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imported dynamically by bridge.ts, only in VITE_SANDBOX_CHECKER builds.

import { mountRoot } from '../../mount/root.js';
import { ViolationPanel } from './ViolationPanel.js';

const ROOT = 'sandbox-checker';

/**
 * Shows the violation panel for `iframe` and returns a dispose that may run more than once. A render error,
 * even a late one, disposes and removes the panel so it never stays frozen and running.
 */
export function mountViolationPanel(iframe: HTMLIFrameElement): () => void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return mountRoot(ROOT, container, () => <ViolationPanel iframe={iframe} />, {
    removeContainer: true,
  });
}
