// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IframeHostOptions, WorkerPairingHostRuntime } from '@parity/truapi-host/web';
import type { ChainPoolWatcher } from '@dotli/chains';
import { isSandboxOrigin } from '@dotli/config';
import { startSandboxChannel, type StartedSandboxChannel } from '@dotli/sandbox-wire';
import { createBlockingModalCoordinator } from './blocking-modal-queue.js';
import { createBridge, type Bridge, type BridgePorts } from './create-bridge.js';
import type { CoreRuntimeRequest } from './core-runtime.js';
import type { DotliAuthState } from './host-callbacks/AuthState.js';
import { createSyncStore } from '@dotli/shared';
import { StubElement } from './testing/stub-element.js';
import { makeProvider } from './page-core.fake.js';
import type { HostCallbackPorts } from './host-callbacks/handlers.js';
import { createFakePrompts } from './host-prompts.fake.js';
import { fakeProductFrameView } from './product-frame.fake.js';

let channel: StartedSandboxChannel | null = null;

/** A handler that throws fails the test. */
const rethrow = (error: unknown): never => {
  throw error;
};

afterEach(() => {
  channel?.stop();
  channel = null;
});

/** The page's ports, over fakes. */
function pagePorts(): BridgePorts {
  return {
    coordinator: createBlockingModalCoordinator(),
    prompts: createFakePrompts().prompts,
    notifications: {
      schedule: () => Promise.resolve({ ok: true, id: 1, immediate: true }),
      cancel: () => Promise.resolve(true),
    },
    frameView: fakeProductFrameView().view,
    chainActivity: { onActivity: () => undefined, onBestBlock: () => undefined },
  };
}

/**
 * The page's bridge over a fake core runtime and frame host, recording the ports its cores were booted on, each boot
 * request, each frame asked for and each chain watcher attached.
 */
function harness(): {
  bridge: Bridge;
  booted: HostCallbackPorts[];
  watchers: ChainPoolWatcher[];
  requests: CoreRuntimeRequest[];
  frames: IframeHostOptions[];
  container: HTMLElement;
} {
  const container = new StubElement('div', { root: true }).asHtml();
  const booted: HostCallbackPorts[] = [];
  const requests: CoreRuntimeRequest[] = [];
  const frames: IframeHostOptions[] = [];
  const watchers: ChainPoolWatcher[] = [];
  const bridge = createBridge({
    bootRuntime: ports => {
      booted.push(ports);
      return request => {
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
      };
    },
    onStoredSessionChanged: () => () => undefined,
    createIframeHost: options => {
      frames.push(options);
      const iframe = new StubElement('iframe').asIframe();
      options.container.appendChild(iframe);
      return Promise.resolve({
        iframe,
        dispose: () => {
          iframe.remove();
        },
      });
    },
    container: () => container,
    onPermissionsChanged: () => () => undefined,
    watchChains: watcher => {
      watchers.push(watcher);
    },
    auth: createSyncStore<DotliAuthState>('auth', { tag: 'Disconnected' }),
    session: { reportLoginFailure: vi.fn(), reportLogoutWithoutCore: vi.fn() },
    walletMode: () => 'app',
    leaveLocalWallet: () => Promise.resolve('reloading'),
  });
  return { bridge, booted, watchers, requests, frames, container };
}

function sandboxChannel(): StartedSandboxChannel {
  channel = startSandboxChannel({ target: new EventTarget(), isTrustedOrigin: isSandboxOrigin, report: rethrow });
  return channel;
}

describe('bridge', () => {
  it('As the shell, I start the product frame after the page core is built and a second start hands me the same frame', () => {
    // Given
    const { bridge } = harness();
    bridge.initBridge(pagePorts());

    // When
    const first = bridge.startProductFrame(sandboxChannel());
    const second = bridge.startProductFrame(sandboxChannel());

    // Then
    expect(second).toBe(first);
    expect(first.getStatus()).toBe('idle');
  });

  it('As the shell, a repeated initBridge keeps the first core and the ports it was booted on', () => {
    // Given
    const { bridge, booted } = harness();
    const first = pagePorts();

    // When
    bridge.initBridge(first);
    bridge.initBridge(pagePorts());

    // Then
    expect(booted).toEqual([{ prompts: first.prompts, notifications: first.notifications }]);
  });

  it('As the network panel, the host chains report to me from the first initBridge and a repeat attaches no second watch', () => {
    // Given
    const { bridge, watchers } = harness();
    const first = pagePorts();

    // When
    bridge.initBridge(first);
    bridge.initBridge(pagePorts());

    // Then
    expect(watchers).toEqual([first.chainActivity]);
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
