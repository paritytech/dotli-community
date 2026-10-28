// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the sandbox tells its host.

import { postToHost } from '@dotli/sandbox-wire';
import { realTimers, type Timers } from '@dotli/shared';

import type { SandboxStep } from './runSandbox.js';

type Params = {
  /** The host page that framed this sandbox. */
  parent: Pick<Window, 'postMessage'>;
  /** The clock each debug event is stamped with. */
  timers?: Pick<Timers, 'now'>;
};

type ReportDebugParams = {
  /** The event's name on the debug bus. */
  event: string;
  /** The flow the event belongs to. */
  flowId: string;
  /** What the event carries. */
  payload: Record<string, unknown>;
};

/** The messages this sandbox posts to `parent`, the host page that framed it. */
export function createHostMessages({ parent, timers = realTimers }: Params) {
  return {
    /** Puts `message` on the host's loading screen as progress text. Throws what posting to the host throws. */
    showStatus,
    /** Ends the host's loading screen with the load's outcome. Throws what posting to the host throws. */
    notifyLoadingDone,
    /** Ends the host's loading screen with no outcome. Throws what posting to the host throws. */
    dismissLoading,
    /**
     * Sends one event to the host's debug bus, stamped with the current time. Sent always, since only the host knows
     * whether the panel is open. Throws what posting to the host throws.
     */
    reportDebug,
    /**
     * Asks the host to render this frame again with its params, and says so on its loading screen. Throws what posting
     * to the host throws.
     */
    askRerender,
  };

  function showStatus(message: string): void {
    postToHost(parent, { type: 'dotli:loading-status', message });
  }

  function notifyLoadingDone(result: { outcome: 'loaded' } | { outcome: 'failed'; failedStep: SandboxStep }): void {
    postToHost(parent, { type: 'dotli:loading-status', done: true, ...result });
  }

  function dismissLoading(): void {
    postToHost(parent, { type: 'dotli:loading-status', done: true });
  }

  function reportDebug({ event, flowId, payload }: ReportDebugParams): void {
    postToHost(parent, {
      type: 'dotli:debug-event',
      event: {
        layer: 'sandbox',
        event,
        flowId,
        timestamp: timers.now(),
        payload,
      },
    });
  }

  function askRerender(): void {
    showStatus('Restoring app...');
    postToHost(parent, { type: 'dotli:sandbox-recover' });
  }
}
