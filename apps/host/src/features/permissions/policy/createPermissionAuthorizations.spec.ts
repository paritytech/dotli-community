// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { createPermissionAuthorizations } from './createPermissionAuthorizations.js';
import type { PermissionAuthorizationRequest, PermissionAuthorizationStatus } from '@parity/truapi-host';

type Store = Map<string, PermissionAuthorizationStatus>;

/** A registry with a connection for `myapp` over an empty store, unregistered when the test finishes. */
function createHarness() {
  const permissions = createPermissionAuthorizations();
  const store: Store = new Map();
  let batchReads = 0;

  /** Registers a connection for `label` that reads and writes `connectionStore`. Returns its unregister. */
  function registerStore(label: string, connectionStore: Store): () => void {
    return permissions.register(label, {
      getPermissionAuthorizationStatuses(requests) {
        batchReads += 1;
        return Promise.resolve(requests.map(request => connectionStore.get(getRequestKey(request)) ?? 'NotDetermined'));
      },
      setPermissionAuthorizationStatus(request, status) {
        const key = getRequestKey(request);
        if (status === 'NotDetermined') {
          connectionStore.delete(key);
        } else {
          connectionStore.set(key, status);
        }
        return Promise.resolve();
      },
    });
  }

  onTestFinished(registerStore('myapp', store));
  return {
    permissions,
    /** The store the first `myapp` connection reads and writes. */
    store,
    registerStore,
    /** How many batch reads the store connections have answered so far. */
    countReads: () => batchReads,
  };
}

function getRequestKey(request: PermissionAuthorizationRequest): string {
  switch (request.tag) {
    case 'Device':
      return `Device:${request.value}`;
    case 'Remote':
      return `Remote:${request.value.permission.tag}`;
    case 'IdentityDisclosure':
      return 'IdentityDisclosure';
    case 'AccountAccess':
      return `AccountAccess:${request.value.targetProductId}`;
    case 'CrossProductSignature':
      return `CrossProductSignature:${request.value.targetProductId}:${request.value.kind}`;
  }
}

describe('createPermissionAuthorizations', () => {
  it('As a dApp user whose app renders again on a replacement core, I read my grant and the newest connection answers until it goes', async () => {
    // Given the connection on screen, then a newer one with its own answer
    const { permissions, store, registerStore } = createHarness();
    const unregister = registerStore('myapp', new Map([['Device:Notifications', 'Denied']]));
    store.set('Device:Notifications', 'Authorized');

    // When the newer connection answers, then goes
    const whileNewer = await permissions.getStatus('myapp', 'Notifications');
    unregister();
    const afterNewer = await permissions.getStatus('myapp', 'Notifications');

    // Then
    expect([whileNewer, afterNewer]).toEqual(['denied', 'granted']);
  });
});

describe('getStatus / setStatus', () => {
  it.each<{ answers: string; answered: PermissionAuthorizationStatus[]; statuses: string[] }>([
    { answers: 'none', answered: [], statuses: ['ask', 'ask'] },
    {
      answers: 'more than asked',
      answered: ['Authorized', 'Denied', 'NotDetermined'],
      statuses: ['granted', 'denied'],
    },
  ])(
    "As the host, I ask a product's statuses of a connection that answers $answers and get one status per permission",
    async ({ answered, statuses }) => {
      // Given an `oddapp` connection whose answer does not match the permissions asked
      const { permissions } = createHarness();
      onTestFinished(
        permissions.register('oddapp', {
          getPermissionAuthorizationStatuses() {
            return Promise.resolve(answered);
          },
          setPermissionAuthorizationStatus() {
            return Promise.resolve();
          },
        }),
      );

      // When
      const asked = await permissions.getStatuses('oddapp', ['Notifications', 'Camera']);

      // Then
      expect(asked).toEqual(statuses);
    },
  );

  it('As a dApp user, I decide my permissions and find them in the core authorization store', async () => {
    // Given
    const { permissions, store } = createHarness();

    // When
    await permissions.setStatus({ label: 'myapp', permission: 'ChainSubmit', status: 'granted' });
    await permissions.setStatus({ label: 'myapp', permission: 'Camera', status: 'denied' });
    const statuses = await permissions.getStatuses('myapp', ['ChainSubmit', 'Camera']);

    // Then
    expect(store).toEqual(
      new Map([
        ['Remote:ChainSubmit', 'Authorized'],
        ['Device:Camera', 'Denied'],
      ]),
    );
    expect(statuses).toEqual(['granted', 'denied']);
  });

  it('As a dApp user who allowed the camera in an earlier version, I read it as left to the browser while another grant stays', async () => {
    // Given
    const { permissions, store } = createHarness();
    store.set('Device:Camera', 'Authorized');
    store.set('Device:Notifications', 'Authorized');

    // When
    const statuses = await permissions.getStatuses('myapp', ['Camera', 'Notifications']);

    // Then
    expect(statuses).toEqual(['ask', 'granted']);
  });

  it('As a dApp user, I read several permission statuses and they come from one provider call', async () => {
    // Given
    const { permissions, countReads } = createHarness();

    // When
    await permissions.getStatuses('myapp', ['ChainSubmit', 'Camera', 'Microphone']);

    // Then
    expect(countReads()).toBe(1);
  });

  it('As a dApp user, I grant one app a permission and another app still asks', async () => {
    // Given an `otherapp` connection with its own store
    const { permissions, registerStore } = createHarness();
    onTestFinished(registerStore('otherapp', new Map()));
    await permissions.setStatus({ label: 'myapp', permission: 'ChainSubmit', status: 'granted' });

    // When
    const status = await permissions.getStatus('otherapp', 'ChainSubmit');

    // Then
    expect(status).toBe('ask');
  });

  it('As the host, I read the statuses of a product before its core connection is registered and each reads ask', async () => {
    // Given no connection of `otherapp`
    const { permissions } = createHarness();

    // When
    const statuses = await permissions.getStatuses('otherapp', ['ChainSubmit', 'Notifications']);

    // Then
    expect(statuses).toEqual(['ask', 'ask']);
  });
});

describe('getAllowAttribute', () => {
  it('As a dApp user, I open an app I set nothing for and its frame lets the browser ask for every device it gates', async () => {
    // Given
    const { permissions } = createHarness();

    // When
    const allow = await permissions.getAllowAttribute('myapp');

    // Then
    expect(allow).toBe(
      'clipboard-write; display-capture; screen-wake-lock; camera; microphone; geolocation; accelerometer; gyroscope; bluetooth; clipboard-read; publickey-credentials-get',
    );
  });

  it('As a dApp user, I block the camera and grant a submit permission, and the frame drops only the camera', async () => {
    // Given
    const { permissions } = createHarness();
    await permissions.setStatus({ label: 'myapp', permission: 'Camera', status: 'denied' });
    await permissions.setStatus({ label: 'myapp', permission: 'ChainSubmit', status: 'granted' });

    // When
    const allow = await permissions.getAllowAttribute('myapp');

    // Then
    expect(allow).toBe(
      'clipboard-write; display-capture; screen-wake-lock; microphone; geolocation; accelerometer; gyroscope; bluetooth; clipboard-read; publickey-credentials-get',
    );
  });

  it('As a dApp user, I open an app before its core connection is registered and its frame lets no gated device in', async () => {
    // Given no connection of `otherapp`
    const { permissions } = createHarness();

    // When
    const allow = await permissions.getAllowAttribute('otherapp');

    // Then
    expect(allow).toBe('clipboard-write; display-capture; screen-wake-lock');
  });
});
