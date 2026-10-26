// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
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
import { makeProvider } from './page-core.fake.js';
import { createPermissionAuthorizations } from './permissions.js';
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
function harness(options: { bootError?: Error; activateError?: Error; firstDisconnectError?: Error } = {}) {
  const requests: CoreRuntimeRequest[] = [];
  const runtimes: {
    resetSessionState: Mock<() => Promise<void>>;
    disconnectSession: Mock<() => Promise<void>>;
    activateExternalSession: Mock<(blob: Uint8Array) => Promise<void>>;
    dispose: Mock<() => void>;
  }[] = [];
  // Every call on a runtime, in order, so a test can tell which came first.
  const runtimeCalls: string[] = [];
  const session = { coresGone: vi.fn() };
  let watches = 0;
  const bridge: Bridge = createBridge({
    bootRuntime: request => {
      requests.push(request);
      if (options.bootError !== undefined) {
        return Promise.reject(options.bootError);
      }
      const runtime = {
        createProvider: () => Promise.resolve(makeProvider()),
        cancelPairing: vi.fn(),
        disconnectSession: vi.fn(() => {
          runtimeCalls.push('disconnectSession');
          const failure = runtimes.length === 1 ? options.firstDisconnectError : undefined;
          return failure === undefined ? Promise.resolve() : Promise.reject(failure);
        }),
        resetSessionState: vi.fn(() => {
          runtimeCalls.push('resetSessionState');
          return Promise.resolve();
        }),
        activateExternalSession: vi.fn((_blob: Uint8Array) => {
          runtimeCalls.push('activateExternalSession');
          return options.activateError === undefined ? Promise.resolve() : Promise.reject(options.activateError);
        }),
        notifySessionStoreChanged: vi.fn(),
        dispose: vi.fn(() => {
          runtimeCalls.push('dispose');
        }),
      };
      runtimes.push(runtime);
      return Promise.resolve({
        runtime: runtime as unknown as WorkerPairingHostRuntime,
        local: false,
        stale: () => Promise.resolve(false),
      });
    },
    onStoredSessionChanged: () => () => undefined,
    createIframeHost: () => Promise.resolve({ iframe: fakeIframe(), dispose: () => undefined }),
    onPermissionsChanged: () => () => undefined,
    permissions: createPermissionAuthorizations(),
    frameView: fakeProductFrameView().view,
    notify: () => undefined,
    watchChains: () => {
      watches += 1;
    },
    session,
  });
  return { bridge, watches: () => watches, requests, runtimes, runtimeCalls, session };
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
  });

  it('As the network panel, the host chains report to me from the first initBridge, and a repeat keeps that core and attaches no second watch', async () => {
    // Given
    const { bridge, watches, requests } = harness();
    const first = recordingCoordinator();
    const second = recordingCoordinator();
    bridge.initBridge(first.coordinator);

    // When
    bridge.initBridge(second.coordinator);
    (await bridge.core.acquire()).release();

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

  it('As a user signing out before the page core is built, I cancel and reset and no core is found or booted', async () => {
    // Given a bridge with no page core yet
    const { bridge, requests } = harness();

    // When the sign-out cancels pairing and resets the session
    bridge.core.cancelPairing();
    await bridge.core.resetSession();

    // Then no core was booted
    expect(requests).toHaveLength(0);
  });

  it('As a user signing out, I reset the core already running and no other boots', async () => {
    // Given a page whose core runs
    const { bridge, requests, runtimeCalls } = harness();
    bridge.initBridge(createBlockingModalCoordinator());
    const lease = await bridge.core.acquire();

    // When the sign-out resets the session
    await bridge.core.resetSession();

    // Then the running core reset its session and no other booted
    expect(requests).toHaveLength(1);
    expect(runtimeCalls).toEqual(['resetSessionState']);
    lease.release();
  });

  it('As a user signing out, I end the stored session on a memory-only core of my own, which stays up to tell the phone and ends the next one too', async () => {
    // Given two stored sessions and a built bridge
    const first = Uint8Array.from([1, 2, 3]);
    const second = Uint8Array.from([4, 5, 6]);
    const { bridge, requests, runtimes, runtimeCalls } = harness();
    bridge.initBridge(createBlockingModalCoordinator());

    // When both sessions are ended
    await bridge.endSession(first);
    await bridge.endSession(second);

    // Then the core never spoke for the page's session, and was not disposed under the phone's message
    expect(requests).toHaveLength(1);
    expect(requests[0]?.sessionInMemory).toBe(true);
    expect(requests[0]?.inService()).toBe(false);
    expect(runtimeCalls).toEqual([
      'activateExternalSession',
      'disconnectSession',
      'activateExternalSession',
      'disconnectSession',
    ]);
    expect(runtimes[0]?.activateExternalSession.mock.calls).toEqual([[first], [second]]);
  });

  it('As a user signing out whose core refuses the session, I hear it and that core goes, so the next end boots another', async () => {
    // Given a core that refuses the session
    const failure = new Error('not a session');
    const { bridge, requests, runtimeCalls } = harness({ activateError: failure });
    bridge.initBridge(createBlockingModalCoordinator());

    // When a session is ended
    const ending = bridge.endSession(Uint8Array.from([1]));

    // Then the end rejects with the refusal and the core is disposed
    await expect(ending).rejects.toBe(failure);
    expect(runtimeCalls).toEqual(['activateExternalSession', 'dispose']);

    // When another session is ended
    await expect(bridge.endSession(Uint8Array.from([1]))).rejects.toBe(failure);

    // Then a second core was booted for it
    expect(requests).toHaveLength(2);
  });

  it('As a user signing out whose core could not disconnect, I hear it and that core goes, so the next end boots another', async () => {
    // Given a core whose first disconnect fails
    const failure = new Error('worker fatal error: disconnect');
    const { bridge, requests, runtimeCalls } = harness({ firstDisconnectError: failure });
    bridge.initBridge(createBlockingModalCoordinator());

    // When one session ends with that failure and another follows
    await expect(bridge.endSession(Uint8Array.from([1]))).rejects.toBe(failure);
    await bridge.endSession(Uint8Array.from([2]));

    // Then the failed core was disposed and a second one ended the next session
    expect(requests).toHaveLength(2);
    expect(runtimeCalls).toEqual([
      'activateExternalSession',
      'disconnectSession',
      'dispose',
      'activateExternalSession',
      'disconnectSession',
    ]);
  });

  it('As a user whose sign-out core failed to boot, I sign out again and it boots again', async () => {
    // Given a sign-out whose core failed to boot
    const { bridge, requests } = harness({ bootError: new Error('worker fatal error: boot') });
    bridge.initBridge(createBlockingModalCoordinator());
    await expect(bridge.endSession(Uint8Array.from([1]))).rejects.toThrow('worker fatal error: boot');

    // When a session is ended again
    const again = bridge.endSession(Uint8Array.from([1]));

    // Then the core boots again and fails the same way
    await expect(again).rejects.toThrow('worker fatal error: boot');
    expect(requests).toHaveLength(2);
  });

  it('As a user signing out before the bridge is built, I end a session and it fails with a named error', async () => {
    // Given a bridge that was never built
    const { bridge, requests } = harness();

    // When a session is ended
    const ending = bridge.endSession(Uint8Array.from([1]));

    // Then it rejects with a named error and no core boots
    await expect(ending).rejects.toThrow('TrUAPI page core used before initBridge');
    expect(requests).toHaveLength(0);
  });
});
