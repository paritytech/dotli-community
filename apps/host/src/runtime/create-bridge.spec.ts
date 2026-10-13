// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerPairingHostRuntime } from '@parity/truapi-host/web';
import { isSandboxOrigin } from '@dotli/config';
import { startSandboxChannel, type StartedSandboxChannel } from '@dotli/sandbox-wire';
import {
  createBlockingModalCoordinator,
  type BlockingModalCoordinator,
  type BlockingModalScope,
} from './blocking-modal-queue.js';
import { createBridge, type Bridge } from './create-bridge.js';
import type { CoreRuntimeRequest } from './core-runtime.js';
import type { DotliAuthState } from './host-callbacks/AuthState.js';
import { createSyncStore, type SyncStore } from '@dotli/shared';
import { makeProvider } from './page-core.fake.js';
import { fakeIframe, fakeProductFrameView } from './product-frame.fake.js';

let channel: StartedSandboxChannel | null = null;

/** A handler that throws fails the test. */
const rethrow = (error: unknown): never => {
  throw error;
};

afterEach(() => {
  channel?.stop();
  channel = null;
});

/**
 * The page's bridge over a fake core runtime and frame host, counting the chain watches it starts and recording each
 * boot request.
 */
function harness(): {
  bridge: Bridge;
  auth: SyncStore<DotliAuthState>;
  watches: () => number;
  requests: CoreRuntimeRequest[];
} {
  const auth = createSyncStore<DotliAuthState>('auth', { tag: 'Disconnected' });
  const requests: CoreRuntimeRequest[] = [];
  let watches = 0;
  const bridge = createBridge({
    bootRuntime: request => {
      requests.push(request);
      const runtime = {
        createProvider: () => Promise.resolve(makeProvider()),
        cancelPairing: vi.fn(),
        disconnectSession: () => Promise.resolve(),
        notifySessionStoreChanged: vi.fn(),
        dispose: vi.fn(),
      };
      return Promise.resolve({
        runtime: runtime as unknown as WorkerPairingHostRuntime,
        local: false,
        stale: () => Promise.resolve(false),
      });
    },
    onStoredSessionChanged: () => () => undefined,
    createIframeHost: () => Promise.resolve({ iframe: fakeIframe(), dispose: () => undefined }),
    onPermissionsChanged: () => () => undefined,
    frameView: fakeProductFrameView().view,
    notify: () => undefined,
    watchChains: () => {
      watches += 1;
    },
    auth,
    session: { reportLoginFailure: vi.fn(), reportLogoutWithoutCore: vi.fn() },
    walletMode: () => 'app',
    leaveLocalWallet: () => Promise.resolve('reloading'),
  });
  return { bridge, auth, watches: () => watches, requests };
}

/** The page's blocking-modal queue, recording each scope a core takes from it. */
function recordingCoordinator(): { coordinator: BlockingModalCoordinator; scopes: BlockingModalScope[] } {
  const queue = createBlockingModalCoordinator();
  const scopes: BlockingModalScope[] = [];
  return {
    coordinator: {
      createScope: () => {
        const scope = queue.createScope();
        scopes.push(scope);
        return scope;
      },
    },
    scopes,
  };
}

function sandboxChannel(): StartedSandboxChannel {
  channel = startSandboxChannel({ target: new EventTarget(), isTrustedOrigin: isSandboxOrigin, report: rethrow });
  return channel;
}

describe('bridge', () => {
  it('As the shell, I start the product frame after the page core is built and a second start hands me the same frame', () => {
    // Given
    const { bridge } = harness();
    bridge.initBridge(createBlockingModalCoordinator());

    // When
    const first = bridge.startProductFrame(sandboxChannel());
    const second = bridge.startProductFrame(sandboxChannel());

    // Then
    expect(second).toBe(first);
    expect(first.getStatus()).toBe('idle');
  });

  it('As the network panel, the host chains report to me from the first initBridge, and a repeat keeps that core and attaches no second watch', async () => {
    // Given
    const { bridge, auth, watches, requests } = harness();
    const first = recordingCoordinator();
    const second = recordingCoordinator();
    bridge.initBridge(first.coordinator);

    // When
    bridge.initBridge(second.coordinator);
    auth.set({ tag: 'Restoring' });
    await bridge.authCommands.logout();

    // Then
    expect(watches()).toBe(1);
    expect(requests).toHaveLength(1);
    expect(first.scopes).toHaveLength(1);
    expect(requests[0]?.blockingModalScope).toBe(first.scopes[0]);
    expect(second.scopes).toEqual([]);
  });

  it('As the shell, starting the product frame before the page core is built fails with a named error', () => {
    // Given
    const { bridge } = harness();

    // When
    const start = (): void => {
      bridge.startProductFrame(sandboxChannel());
    };

    // Then
    expect(start).toThrow('TrUAPI page core used before initBridge');
  });
});
