import 'fake-indexeddb/auto';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateNotification,
  findNotification,
  retainNotification,
  validNotificationRoute,
} from '@dotli/storage/notification-activations';
import { createNotificationAdapters } from '../src/host-callbacks/PushNotification.js';
import {
  notificationContext,
  registerProductNotificationTarget,
  setNotificationAccount,
} from '../src/notification-activation.js';
import { resetOverlays } from './helpers/overlays.js';

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

describe('product notifications', () => {
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
