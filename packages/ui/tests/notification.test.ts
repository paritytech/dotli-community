import 'fake-indexeddb/auto';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateNotification,
  findNotification,
  pendingNotificationActivations,
  retainNotification,
  validNotificationRoute,
} from '@dotli/storage/notification-activations';
import { createNotificationAdapters } from '../src/host-callbacks/PushNotification.js';
import {
  notificationContext,
  registerProductNotificationTarget,
  setNotificationAccount,
} from '../src/notification-activation.js';
import { toastsStore } from '../src/state/toasts.js';
import { overlaysReady, resetOverlays } from './helpers/overlays.js';

const environment = vi.hoisted(() => ({ network: 'paseo-next-v2' }));
vi.mock('@dotli/config', async importOriginal => ({
  ...(await importOriginal<object>()),
  getNetwork: () => environment.network,
}));

let count = 0;
let label: string;
let dispose: () => void;
const account = '11'.repeat(32);
const focus = vi.fn();

beforeEach(() => {
  label = `notification-test-${String(++count)}`;
  environment.network = 'paseo-next-v2';
  focus.mockClear();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  setNotificationAccount(label, account);
  dispose = registerProductNotificationTarget(label, {
    artifact: 'verified-artifact',
    entryUrl: 'https://chat.paseo.fyi/',
    isActive: () => true,
    focus,
  });
});

afterEach(() => {
  dispose();
  setNotificationAccount(label, undefined);
  resetOverlays();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('bound notification activation', () => {
  it('retains an in-page click until exact acknowledgement without navigating/reloading the product', async () => {
    const api = createNotificationAdapters(label);
    const pushed = await api.pushNotification({ text: 'Open conversation', deeplink: '/dm/alice' });
    const record = await findNotification(label, pushed.id);
    assert.isDefined(record);
    await overlaysReady();
    const body = document.querySelector<HTMLButtonElement>('.notif-body');
    expect(body?.textContent).toBe('Open conversation');
    body?.click();
    await vi.waitFor(async () => {
      expect((await api.activationEvents()).events).toEqual([
        { sequence: BigInt(record.sequence), notificationId: pushed.id, route: '/dm/alice' },
      ]);
    });
    const { events } = await api.activationEvents();
    const first = events[0];
    assert.isDefined(first);
    expect((await api.activationEvents()).events).toEqual(events);
    expect(focus).toHaveBeenCalledOnce();
    await api.acknowledgeActivation({ sequence: first.sequence + 999n });
    expect((await api.activationEvents()).events).toEqual(events);
    await api.acknowledgeActivation({ sequence: first.sequence });
    expect((await api.activationEvents()).events).toEqual([]);
    expect(await activateNotification(record.token)).toBeUndefined();
  });

  it.each(['account', 'network', 'artifact', 'product'] as const)(
    'does not expose or acknowledge another %s scope',
    async field => {
      const api = createNotificationAdapters(label);
      const pushed = await api.pushNotification({ text: 'Private', deeplink: '/dm/alice' });
      const record = await findNotification(label, pushed.id);
      assert.isDefined(record);
      await activateNotification(record.token);
      if (field === 'account') {
        setNotificationAccount(label, '22'.repeat(32));
      }
      if (field === 'network') {
        environment.network = 'other-environment';
      }
      if (field === 'artifact') {
        dispose();
        dispose = registerProductNotificationTarget(label, {
          artifact: 'replacement-artifact',
          entryUrl: record.entryUrl,
          isActive: () => true,
          focus,
        });
      }
      if (field === 'product') {
        dispose();
        setNotificationAccount('another-product', account);
        dispose = registerProductNotificationTarget('another-product', {
          artifact: 'verified-artifact',
          entryUrl: record.entryUrl,
          isActive: () => true,
          focus,
        });
      }
      const current = field === 'product' ? createNotificationAdapters('another-product') : api;
      expect((await current.activationEvents()).events).toEqual([]);
      await current.acknowledgeActivation({ sequence: BigInt(record.sequence) });
      expect(await pendingNotificationActivations(record.scope)).toEqual([
        expect.objectContaining({ route: '/dm/alice' }),
      ]);
    },
  );

  it('invalidates stale toast clicks on logout and returns events after the same account reconnects', async () => {
    const api = createNotificationAdapters(label);
    const pushed = await api.pushNotification({ text: 'Private', deeplink: '/dm/alice' });
    await overlaysReady();
    const activate = toastsStore.get().items.at(-1)?.onActivate;
    window.dispatchEvent(new Event('dotli:logged-out'));
    activate?.();
    await expect(api.activationEvents()).rejects.toThrow('authenticated account');
    expect(focus).not.toHaveBeenCalled();
    const record = await findNotification(label, pushed.id);
    assert.isDefined(record);
    await activateNotification(record.token); // An OS click while the page is logged out.
    setNotificationAccount(label, account);
    expect((await api.activationEvents()).events).toEqual([
      { sequence: BigInt(record.sequence), notificationId: pushed.id, route: '/dm/alice' },
    ]);
  });

  it('makes cancelled and expired notification tokens inert', async () => {
    const api = createNotificationAdapters(label);
    const pushed = await api.pushNotification({ text: 'Cancelled', deeplink: '/dm/alice' });
    const record = await findNotification(label, pushed.id);
    assert.isDefined(record);
    await api.cancelNotification(pushed.id);
    expect(await activateNotification(record.token)).toBeUndefined();
    const expired = await retainNotification({
      scope: notificationContext(label).scope,
      notificationId: 1000,
      entryUrl: record.entryUrl,
      route: '/dm/bob',
      expiresAt: Date.now() - 1,
    });
    expect(await activateNotification(expired.token)).toBeUndefined();
    expect((await api.activationEvents()).events).toEqual([]);
  });

  it.each(['permission rejected', 'worker installing'])(
    'keeps the toast actionable when OS delivery is unavailable: %s',
    async failure => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(false);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.stubGlobal('Notification', {
        permission: failure === 'permission rejected' ? 'default' : 'granted',
        requestPermission: () => Promise.reject(new Error('User activation required')),
      });
      vi.stubGlobal('navigator', { serviceWorker: { getRegistration: () => Promise.resolve({ active: null }) } });
      const api = createNotificationAdapters(label);
      const pushed = await api.pushNotification({ text: 'Still actionable', deeplink: '/dm/alice' });
      const record = await findNotification(label, pushed.id);
      assert.isDefined(record);
      await overlaysReady();
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      document.querySelector<HTMLButtonElement>('.notif-body')?.click();
      await vi.waitFor(async () => {
        expect((await api.activationEvents()).events).toEqual([
          { sequence: BigInt(record.sequence), notificationId: pushed.id, route: '/dm/alice' },
        ]);
      });
    },
  );

  it('retires old unclicked notifications at capacity without evicting clicked pending events', async () => {
    const scope = notificationContext(label).scope;
    const request = { scope, entryUrl: 'https://chat.paseo.fyi/', route: '/dm/alice', expiresAt: Date.now() + 60_000 };
    const pending = await retainNotification({ ...request, notificationId: 1000 });
    await activateNotification(pending.token);
    const oldest = await retainNotification({ ...request, notificationId: 1001 });
    for (let id = 1002; id <= 1258; id++) {
      await retainNotification({ ...request, notificationId: id });
    }
    expect(await activateNotification(oldest.token)).toBeUndefined();
    expect(await pendingNotificationActivations(scope)).toEqual([expect.objectContaining({ token: pending.token })]);
    const api = createNotificationAdapters(label);
    await api.acknowledgeActivation({ sequence: BigInt(pending.sequence) });
    await retainNotification({ ...request, notificationId: 1259 });
    expect(await findNotification(label, pending.notificationId)).toBeUndefined();
    expect(await activateNotification(pending.token)).toBeUndefined();
  });

  it.each([
    '//attacker.test',
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'https://user:password@attacker.test/dm/a',
    '/\\attacker.test',
    '/%2fattacker.test',
    '/dm/%0a',
    '/dm/%ZZ',
  ])('rejects unsafe destination %s before notification creation', async route => {
    expect(validNotificationRoute(route)).toBe(false);
    await expect(
      createNotificationAdapters(label).pushNotification({ text: 'Unsafe', deeplink: route }),
    ).rejects.toThrow();
  });
});
