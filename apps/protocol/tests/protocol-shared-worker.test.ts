// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The SharedWorker module runs at import: it reads the network from its name,
// subscribes to the light client's fatal and starts pre-sync. The light client
// is faked at the `@dotli/resolver` seam, and the worker scope is happy-dom's
// window, which the module sees as `self`.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as MetricsModule from '@dotli/metrics';

const resolver = vi.hoisted(() => ({
  fatal: null as ((message: string) => void) | null,
}));

vi.mock('@dotli/resolver', () => ({
  createChainProvider: () => null,
  isChainSupported: () => true,
  onProviderFatal: (cb: (message: string) => void) => {
    resolver.fatal = cb;
    return () => undefined;
  },
  onSmoldotDbOutcome: () => () => undefined,
  resolveDotName: () => Promise.resolve(null),
  resolveExecutableManifest: () => Promise.resolve(null),
  resolveOwner: () => Promise.resolve(null),
  resolveRootManifest: () => Promise.resolve(null),
  setResolverAssetHubProvider: () => undefined,
  setResolverPeopleProvider: () => undefined,
  waitForAssetHubFinalized: () => Promise.resolve(),
  // People warms in the background; it never settles here.
  waitForPeopleFinalized: () => new Promise<void>(() => undefined),
}));

vi.mock('@dotli/metrics', async importOriginal => ({
  ...(await importOriginal<typeof MetricsModule>()),
  initSentry: () => undefined,
  installGlobalErrorHandlers: () => undefined,
}));

interface FakePort {
  posted: Mock<(message: unknown) => void>;
  port: MessagePort;
}

function fakePort(): FakePort {
  const posted = vi.fn<(message: unknown) => void>();
  const port = {
    addEventListener: () => undefined,
    start: () => undefined,
    postMessage: posted,
  } as unknown as MessagePort;
  return { posted, port };
}

/** Connect a port to the worker as a tab's protocol iframe would. */
function connect(): FakePort {
  const port = fakePort();
  const event = new Event('connect');
  Object.defineProperty(event, 'ports', { value: [port.port] });
  self.dispatchEvent(event);
  return port;
}

const flush = (): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, 0);
  });

describe('protocol SharedWorker', () => {
  let warn: Mock<(...args: unknown[]) => void>;
  let error: Mock<(...args: unknown[]) => void>;

  beforeEach(async () => {
    warn = vi.fn<(...args: unknown[]) => void>();
    error = vi.fn<(...args: unknown[]) => void>();
    vi.spyOn(console, 'warn').mockImplementation(warn);
    vi.spyOn(console, 'error').mockImplementation(error);
    window.name = 'dotli-protocol-paseo-next-v2';
    vi.resetModules();
    await import('../src/protocol-shared-worker.js');
    await flush();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('As a dotli user on the shared light client, a tab that joins after the light client died hears why instead of ready', () => {
    // Given: a tab on a synced worker whose light client then cannot connect a chain.
    const first = connect();
    expect(first.posted).toHaveBeenCalledWith({ type: 'ready' });
    resolver.fatal?.('chain 0xaa connection failed: wasm trap');

    // When: another tab, or the same one after its retry, connects.
    const later = connect();

    // Then: it is told the light client is dead, and never that it is ready.
    expect(first.posted).toHaveBeenCalledWith({
      type: 'relay-response',
      envelope: { namespace: 'dotli:protocol', kind: 'fatal', message: 'chain 0xaa connection failed: wasm trap' },
    });
    expect(later.posted.mock.calls).toEqual([[{ type: 'error', message: 'chain 0xaa connection failed: wasm trap' }]]);
    expect(error).toHaveBeenCalledWith('[dot.li SW]', 'Chain death detected, broadcasting fatal to 1 port(s)');
    expect(warn).toHaveBeenCalledWith('[dot.li SW]', 'Pre-sync complete, engine ready');
  });
});
