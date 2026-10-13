// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the sandbox tells its host. `runSandbox` refuses a top-level page, so these always reach the host parent.

import { postToHost } from '@dotli/sandbox-wire';

import type { SandboxStep } from './sandbox-run.js';

/** Progress text for the host's loading screen. */
export function showStatus(message: string): void {
  postToHost(window.parent, { type: 'dotli:loading-status', message });
}

/** Ends the host's loading screen with the load's outcome. */
export function notifyLoadingDone(
  result: { outcome: 'loaded' } | { outcome: 'failed'; failedStep: SandboxStep },
): void {
  postToHost(window.parent, { type: 'dotli:loading-status', done: true, ...result });
}

/** For a prompt shown before the content has loaded. */
export function dismissHostLoading(): void {
  postToHost(window.parent, { type: 'dotli:loading-status', done: true });
}

/** The host relays it to its debug bus. Sent always, since only the host knows whether the panel is open. */
export function reportSandboxDebug(event: string, flowId: string, payload: Record<string, unknown>): void {
  postToHost(window.parent, {
    type: 'dotli:debug-event',
    event: {
      layer: 'sandbox',
      event,
      flowId,
      timestamp: Date.now(),
      payload,
    },
  });
}

/** Asks the host to render this frame again, after a reload stripped the contract params. */
export function askHostToRerender(): void {
  showStatus('Restoring app...');
  postToHost(window.parent, { type: 'dotli:sandbox-recover' });
}
