// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const receiver = vi.hoisted(() => ({
  enableWebPush: vi.fn(() => Promise.resolve()),
  setActiveAccount: vi.fn(() => Promise.resolve()),
  revokeAll: vi.fn(() => Promise.resolve()),
}));
const createClient = vi.hoisted(() => vi.fn(() => receiver));
const requestPermission = vi.fn();
vi.mock('@parity/truapi-host/browser-receiving', () => ({ createBrowserReceivingClient: createClient }));
const entries = [
  {
    origin: 'https://t3ams-push-test.paseo.fyi',
    relayUrl: 'https://t3ams-push-test.paseo.fyi/__receiving',
    vapidPublicKey: `B${'A'.repeat(86)}`,
  },
  {
    origin: 'https://echat-new.paseo.fyi',
    relayUrl: 'https://echat-new.paseo.fyi/__receiving',
    vapidPublicKey: `B${'B'.repeat(85)}A`,
  },
] as const;
const registration = { active: {}, pushManager: { getSubscription: vi.fn(() => Promise.resolve(null)) } };

beforeEach(() => {
  // The receiving client/account singleton must be created under each test's origin.
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('VITE_RECEIVING_ORIGINS', JSON.stringify(entries));
  vi.stubGlobal('navigator', {
    serviceWorker: { getRegistration: vi.fn(() => Promise.resolve(registration)) },
    locks: {},
  });
  vi.stubGlobal('Notification', { permission: 'default', requestPermission });
  vi.stubGlobal('PushManager', {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('receiving enrollment authority', () => {
  it.each(entries)('passes only $origin own VAPID key on explicit enable', async entry => {
    vi.stubGlobal('location', new URL(entry.origin));
    // Dynamic import intentionally creates the singleton after browser setup.
    const { receivingStatus, enableReceivingPush } = await import('../src/receiving.js');
    expect(await receivingStatus()).toMatchObject({ supported: true, enabled: false });
    expect(receiver.enableWebPush).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
    await enableReceivingPush();
    expect(receiver.enableWebPush).toHaveBeenCalledExactlyOnceWith(entry.vapidPublicKey);
  });

  it.each([
    'https://paseo.fyi',
    'https://host.paseo.fyi',
    'https://cid.app.paseo.fyi',
    'https://other.paseo.fyi',
    'https://echat-new.paseo.fyi.attacker.test',
  ])('keeps %s unsupported', async origin => {
    vi.stubGlobal('location', new URL(origin));
    const { receivingStatus, enableReceivingPush } = await import('../src/receiving.js');
    expect(await receivingStatus()).toMatchObject({ supported: false, enabled: false });
    await expect(enableReceivingPush()).rejects.toThrow();
    expect(createClient).not.toHaveBeenCalled();
    expect(receiver.enableWebPush).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('cannot enroll before Settings has prepared the client', async () => {
    vi.stubGlobal('location', new URL(entries[0].origin));
    const { enableReceivingPush } = await import('../src/receiving.js');
    await expect(enableReceivingPush()).rejects.toThrow('Receiving is not ready');
    expect(createClient).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('does not reuse a prepared client key after the current origin no longer matches', async () => {
    vi.stubGlobal('location', new URL(entries[0].origin));
    const { receivingStatus, enableReceivingPush } = await import('../src/receiving.js');
    expect(await receivingStatus()).toMatchObject({ supported: true });
    vi.stubGlobal('location', new URL('https://other.paseo.fyi'));
    await expect(enableReceivingPush()).rejects.toThrow('This origin has no Web Push configuration');
    expect(receiver.enableWebPush).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('keeps account synchronization separate from Web Push enrollment', async () => {
    vi.stubGlobal('location', new URL(entries[0].origin));
    const { receivingStatus, setReceivingAccount } = await import('../src/receiving.js');
    expect(await receivingStatus()).toMatchObject({ supported: true });
    setReceivingAccount(`0x${'ab'.repeat(32)}`);
    await vi.waitFor(() => expect(receiver.setActiveAccount).toHaveBeenCalled());
    expect(receiver.enableWebPush).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('does not treat a configured origin embedded in a public iframe as an enrollment surface', async () => {
    vi.stubGlobal('location', new URL(entries[0].origin));
    vi.spyOn(window, 'top', 'get').mockReturnValue({} as Window);
    const { receivingStatus } = await import('../src/receiving.js');
    expect(await receivingStatus()).toMatchObject({ supported: false, enabled: false });
    expect(createClient).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
