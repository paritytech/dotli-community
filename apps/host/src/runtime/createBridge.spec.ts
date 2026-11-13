// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { asProductId } from '@parity/truapi';
import type { WorkerPairingHostRuntime } from '@parity/truapi-host/web';
import { isSandboxOrigin } from '@dotli/config';
import { catchError, catchRejection } from '@dotli/shared/testing';
import { rethrow } from '../testing/rethrow.js';
import { startSandboxChannel, type StartedSandboxChannel } from '@dotli/sandbox-wire';
import {
  createBlockingModalCoordinator,
  type BlockingModalCoordinator,
  type BlockingModalScope,
} from './createBlockingModalCoordinator.js';
import { createBridge, type Bridge } from './createBridge.js';
import { toProductId } from './getAskedProductId.js';
import type { CoreContext } from './createPageCore.js';
import { createFakeProvider } from './createPageCore.fake.js';
import { createPermissionAuthorizations } from './createPermissionAuthorizations.js';
import { createFakeIframe, createFakeProductFrameView } from './createProductFrame.fake.js';

type Params = {
  /** Every boot rejects with it when given. */
  bootError?: Error;
  /** Every activation of a session rejects with it when given. */
  activateError?: Error;
  /** The first core's disconnects reject with it when given. */
  firstDisconnectError?: Error;
};

/**
 * The page's bridge over a fake core runtime and frame host, counting the chain watches it starts and recording each
 * boot context.
 */
function createHarness({ bootError, activateError, firstDisconnectError }: Params = {}) {
  const contexts: CoreContext[] = [];
  const runtimes: ReturnType<typeof createFakeRuntime>[] = [];
  // Every call on a runtime, in order, so a test can tell which came first.
  const runtimeCalls: string[] = [];
  const session = { reportCoresGone: vi.fn() };
  let watches = 0;
  const bridge: Bridge = createBridge({
    bootRuntime: context => {
      contexts.push(context);
      if (bootError !== undefined) {
        return Promise.reject(bootError);
      }
      const runtime = createFakeRuntime();
      runtimes.push(runtime);
      return Promise.resolve({
        // The fake holds only the runtime members the bridge calls.
        runtime: runtime as unknown as WorkerPairingHostRuntime,
        productId: asProductId(context.product.productId ?? toProductId(context.product.label)),
        local: false,
        isStale: () => Promise.resolve(false),
      });
    },
    subscribeStoredSession: () => () => undefined,
    createIframeHost: () => Promise.resolve({ iframe: createFakeIframe(), dispose: () => undefined }),
    subscribePermissionChanges: () => () => undefined,
    permissions: createPermissionAuthorizations(),
    frameView: createFakeProductFrameView().view,
    notify: () => undefined,
    watchChains: () => {
      watches += 1;
    },
    session,
  });
  return { bridge, watches: () => watches, contexts, runtimes, runtimeCalls, session };

  function createFakeRuntime() {
    return {
      createProvider: () => Promise.resolve(createFakeProvider()),
      cancelPairing: vi.fn(),
      disconnectSession: vi.fn(() => {
        runtimeCalls.push('disconnectSession');
        const failure = runtimes.length === 1 ? firstDisconnectError : undefined;
        return failure === undefined ? Promise.resolve() : Promise.reject(failure);
      }),
      activateExternalSession: vi.fn((_blob: Uint8Array) => {
        runtimeCalls.push('activateExternalSession');
        return activateError === undefined ? Promise.resolve() : Promise.reject(activateError);
      }),
      notifySessionStoreChanged: vi.fn(),
      dispose: vi.fn(() => {
        runtimeCalls.push('dispose');
      }),
    };
  }
}

/** The page's blocking-modal queue, recording each scope a core takes from it. */
function createRecordingCoordinator(): { coordinator: BlockingModalCoordinator; scopes: BlockingModalScope[] } {
  const queue = createBlockingModalCoordinator();
  const scopes: BlockingModalScope[] = [];
  return {
    coordinator: { createScope },
    scopes,
  };

  function createScope(): BlockingModalScope {
    const scope = queue.createScope();
    scopes.push(scope);
    return scope;
  }
}

/** A sandbox channel on a target of its own, stopped when the test finishes. A handler that throws fails the test. */
function startTestSandboxChannel(): StartedSandboxChannel {
  const channel = startSandboxChannel({ target: new EventTarget(), isTrustedOrigin: isSandboxOrigin, report: rethrow });
  onTestFinished(() => {
    channel.stop();
  });
  return channel;
}

describe('bridge', () => {
  it('As a dotli integrator, I start the product frame after the page core is built and a second start hands me the same frame', () => {
    // Given
    const { bridge } = createHarness();
    bridge.initBridge(createBlockingModalCoordinator());

    // When
    const first = bridge.startProductFrame(startTestSandboxChannel());
    const second = bridge.startProductFrame(startTestSandboxChannel());

    // Then
    expect(second).toBe(first);
  });

  it('As a debug panel user, I see the host chains report from the first bridge init and a repeat init keeps that core with no second watch', async () => {
    // Given
    const { bridge, watches, contexts } = createHarness();
    const first = createRecordingCoordinator();
    const second = createRecordingCoordinator();
    bridge.initBridge(first.coordinator);

    // When
    bridge.initBridge(second.coordinator);
    (await bridge.core.acquire()).release();

    // Then
    expect(watches()).toBe(1);
    expect(contexts).toHaveLength(1);
    expect(first.scopes).toHaveLength(1);
    expect(contexts[0]?.blockingModalScope).toBe(first.scopes[0]);
    expect(second.scopes).toEqual([]);
  });

  it('As a dotli integrator, I start the product frame before the page core is built and it fails with a named error', () => {
    // Given
    const { bridge } = createHarness();

    // When
    const error = catchError(() => {
      bridge.startProductFrame(startTestSandboxChannel());
    });

    // Then
    expect(error).toEqual(new Error('TrUAPI page core used before initBridge'));
  });

  it('As a user signing out before the page core is built, I cancel and reset and no core is found or booted', async () => {
    // Given a bridge with no page core yet
    const { bridge, contexts } = createHarness();

    // When the sign-out cancels pairing and resets the session
    bridge.core.cancelPairing();
    await bridge.core.resetSession();

    // Then no core was booted
    expect(contexts).toHaveLength(0);
  });

  it('As a user signing out, I end the stored session on a memory-only core of my own, which stays up to tell the phone and ends the next one too', async () => {
    // Given two stored sessions and a built bridge
    const first = Uint8Array.from([1, 2, 3]);
    const second = Uint8Array.from([4, 5, 6]);
    const { bridge, contexts, runtimes, runtimeCalls } = createHarness();
    bridge.initBridge(createBlockingModalCoordinator());

    // When both sessions are ended
    await bridge.endSession(first);
    await bridge.endSession(second);

    // Then the core never spoke for the page's session, and was not disposed under the phone's message
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.sessionInMemory).toBe(true);
    expect(contexts[0]?.isInService()).toBe(false);
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
    const { bridge, contexts, runtimeCalls } = createHarness({ activateError: failure });
    bridge.initBridge(createBlockingModalCoordinator());

    // When a session is ended, then another
    const firstError = await catchRejection(bridge.endSession(Uint8Array.from([1])));
    const callsAfterFirst = [...runtimeCalls];
    const secondError = await catchRejection(bridge.endSession(Uint8Array.from([1])));

    // Then each end rejects with the refusal, the first core is disposed and a second core was booted
    expect(firstError).toBe(failure);
    expect(callsAfterFirst).toEqual(['activateExternalSession', 'dispose']);
    expect(secondError).toBe(failure);
    expect(contexts).toHaveLength(2);
  });

  it('As a user signing out whose core could not disconnect, I hear it and that core goes, so the next end boots another', async () => {
    // Given a core whose first disconnect fails
    const failure = new Error('worker fatal error: disconnect');
    const { bridge, contexts, runtimeCalls } = createHarness({ firstDisconnectError: failure });
    bridge.initBridge(createBlockingModalCoordinator());

    // When one session ends with that failure and another follows
    const firstError = await catchRejection(bridge.endSession(Uint8Array.from([1])));
    await bridge.endSession(Uint8Array.from([2]));

    // Then the failed core was disposed and a second one ended the next session
    expect(firstError).toBe(failure);
    expect(contexts).toHaveLength(2);
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
    const { bridge, contexts } = createHarness({ bootError: new Error('worker fatal error: boot') });
    bridge.initBridge(createBlockingModalCoordinator());
    const firstError = await catchRejection(bridge.endSession(Uint8Array.from([1])));

    // When a session is ended again
    const again = bridge.endSession(Uint8Array.from([1]));

    // Then the core boots again and fails the same way
    expect(firstError.message).toContain('worker fatal error: boot');
    await expect(again).rejects.toThrow('worker fatal error: boot');
    expect(contexts).toHaveLength(2);
  });

  it('As a user signing out before the bridge is built, I end a session and it fails with a named error', async () => {
    // Given a bridge that was never built
    const { bridge, contexts } = createHarness();

    // When a session is ended
    const ending = bridge.endSession(Uint8Array.from([1]));

    // Then it rejects with a named error and no core boots
    await expect(ending).rejects.toThrow('TrUAPI page core used before initBridge');
    expect(contexts).toHaveLength(0);
  });
});
