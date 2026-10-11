// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const install = vi.hoisted(() => vi.fn());
vi.mock('@parity/truapi-host/browser-receiving-worker', () => ({ installBrowserReceivingWorker: install }));
vi.mock('@parity/truapi-host/wasm/web', () => ({ default: vi.fn(), WasmNotificationReceiver: vi.fn() }));
const entries = [
  {
    origin: 'https://t3ams-push-test.paseo.fyi',
    relayUrl: 'https://t3ams-push-test.paseo.fyi/__receiving',
    vapidPublicKey: `B${'A'.repeat(86)}`,
  },
  {
    origin: 'https://echat-new.paseo.fyi',
    relayUrl: 'https://echat-relay.example/receiving',
    vapidPublicKey: `B${'B'.repeat(85)}A`,
  },
];

beforeEach(() => {
  vi.resetModules();
  install.mockReset();
  // The entrypoint installs at import time; reload it for each simulated worker origin.
  vi.stubGlobal('__RECEIVING_ORIGINS__', entries);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('one worker build, exact-origin transports', () => {
  it.each(entries)('installs only the relay bound to $origin', async entry => {
    vi.stubGlobal('self', { location: { origin: entry.origin }, navigator: { locks: {} } });
    await import('../../src/receiving-worker.js');
    expect(install).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({ relayUrl: entry.relayUrl, pushOrigin: entry.origin }),
    );
  });

  it.each([
    'https://paseo.fyi',
    'https://host.paseo.fyi',
    'https://cid.app.paseo.fyi',
    'https://other.paseo.fyi',
    'https://echat-new.paseo.fyi.attacker.test',
  ])('does not install a receiver for %s', async origin => {
    vi.stubGlobal('self', { location: { origin }, navigator: { locks: {} } });
    await import('../../src/receiving-worker.js');
    expect(install).not.toHaveBeenCalled();
  });

  it('does not install without required locking support', async () => {
    vi.stubGlobal('self', { location: { origin: entries[0]?.origin }, navigator: {} });
    await import('../../src/receiving-worker.js');
    expect(install).not.toHaveBeenCalled();
  });
});
