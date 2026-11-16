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
    const unregister = registerStore('myapp', new Map([['Device:Camera', 'Denied']]));
    store.set('Device:Camera', 'Authorized');

    // When the newer connection answers, then goes
    const whileNewer = await permissions.getStatus('myapp', 'Camera');
    unregister();
    const afterNewer = await permissions.getStatus('myapp', 'Camera');

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
      const asked = await permissions.getStatuses('oddapp', ['Camera', 'Microphone']);

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
    await permissions.setStatus({ label: 'myapp', permission: 'IdentityDisclosure', status: 'granted' });
    const statuses = await Promise.all([
      permissions.getStatus('myapp', 'ChainSubmit'),
      permissions.getStatus('myapp', 'Camera'),
      permissions.getStatus('myapp', 'IdentityDisclosure'),
    ]);

    // Then
    expect(store).toEqual(
      new Map([
        ['Remote:ChainSubmit', 'Authorized'],
        ['Device:Camera', 'Denied'],
        ['IdentityDisclosure', 'Authorized'],
      ]),
    );
    expect(statuses).toEqual(['granted', 'denied', 'granted']);
  });

  it('As a dApp user, I read several permission statuses and they come from one provider call', async () => {
    // Given
    const { permissions, countReads } = createHarness();
    await permissions.setStatus({ label: 'myapp', permission: 'ChainSubmit', status: 'granted' });
    await permissions.setStatus({ label: 'myapp', permission: 'Camera', status: 'denied' });
    const readsBefore = countReads();

    // When
    const statuses = await permissions.getStatuses('myapp', ['ChainSubmit', 'Camera', 'Microphone']);

    // Then
    expect(statuses).toEqual(['granted', 'denied', 'ask']);
    expect(countReads() - readsBefore).toBe(1);
  });

  it('As a dApp user, I grant one app a permission and another app still asks', async () => {
    // Given
    const { permissions } = createHarness();
    await permissions.setStatus({ label: 'myapp', permission: 'Camera', status: 'granted' });

    // When
    const status = await permissions.getStatus('otherapp', 'Camera');

    // Then
    expect(status).toBe('ask');
  });
});

describe('getAllowAttribute', () => {
  it('As a dApp user, I open an app and its frame always receives clipboard-write and screen sharing access', async () => {
    // Given
    const { permissions } = createHarness();

    // When
    const allow = await permissions.getAllowAttribute('myapp');

    // Then
    expect(allow).toBe('clipboard-write; display-capture');
  });

  it('As a dApp user, I grant device permissions and they appear in the app frame policy', async () => {
    // Given
    const { permissions } = createHarness();
    await permissions.setStatus({ label: 'myapp', permission: 'Camera', status: 'granted' });
    await permissions.setStatus({ label: 'myapp', permission: 'Microphone', status: 'granted' });

    // When
    const allow = await permissions.getAllowAttribute('myapp');

    // Then
    expect(allow).toBe('clipboard-write; display-capture; camera; microphone');
  });

  it('As a dApp user, I deny a device permission and grant a submit one and neither enters the app frame policy', async () => {
    // Given
    const { permissions } = createHarness();
    await permissions.setStatus({ label: 'myapp', permission: 'Camera', status: 'denied' });
    await permissions.setStatus({ label: 'myapp', permission: 'ChainSubmit', status: 'granted' });

    // When
    const allow = await permissions.getAllowAttribute('myapp');

    // Then
    expect(allow).toBe('clipboard-write; display-capture');
  });
});
