// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The state the shell's chrome renders. Framework-free because it runs at boot, so each island finds a live store
// whenever it mounts.

import { captureException, m, spans as S } from '@dotli/metrics';
import { errorName, log, registerStoreStateReset } from '@dotli/shared';
import { startProductPermissions } from '@dotli/host-runtime';
import { setTopbarPresent } from './state/topbar.js';
import { initChatPanelState } from './state/chat-panel.js';
import { startNetworkStore } from './state/network.js';
import { startTopbarAutoHide } from './topbar-autohide.js';
import { initNetworkHealth } from './state/network-health.js';
import { initTheme } from './theme-controller.js';

/** Starts one part of the shell state, returning its stop. */
export type ShellPart = () => () => void;

export interface ShellState {
  /** Starts every part, in order, until the returned stop. A second call returns that stop too. */
  start: () => () => void;
  /** Stops what is running, if anything. */
  stop: () => void;
}

/**
 * A part that throws stops the parts already started and fails the start, so the next start begins afresh. A part
 * whose stop throws is reported, and the parts before it still stop.
 */
export function createShellState(parts: readonly ShellPart[]): ShellState {
  let running: (() => void) | null = null;
  return {
    start() {
      if (running !== null) {
        return running;
      }
      const stops: (() => void)[] = [];
      const stop = (): void => {
        for (const stopPart of stops.splice(0).reverse()) {
          try {
            stopPart();
          } catch (err: unknown) {
            captureException(err, { flow: 'ui', step: 'shell_part_stop' });
            log.error('[dot.li] A shell state part did not stop:', err);
            m.count(S.SHELL_STATE_STOP, { outcome: 'error', reason: errorName(err) ?? 'unknown' });
          }
        }
        if (running === stop) {
          running = null;
        }
      };
      // Before any part starts, as their first writes reach store listeners that may call back in here.
      running = stop;
      try {
        for (const part of parts) {
          stops.push(part());
        }
      } catch (cause: unknown) {
        stop();
        throw new Error('Shell state did not start', { cause });
      }
      return stop;
    },
    stop() {
      running?.();
    },
  };
}

const pageShellState = createShellState([
  () => {
    setTopbarPresent();
    return () => undefined;
  },
  initTheme,
  startNetworkStore,
  initNetworkHealth,
  initChatPanelState,
  startProductPermissions,
  startTopbarAutoHide,
]);

/**
 * Starts the theme, network, network health, chat panel, product permission and topbar auto-hide state, until the
 * returned stop. A second call returns that stop too.
 */
export const startShellState: () => () => void = pageShellState.start;

registerStoreStateReset(pageShellState.stop);
