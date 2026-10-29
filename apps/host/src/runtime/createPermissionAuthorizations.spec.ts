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
  }
}

describe('createPermissionAuthorizations', () => {
  it('As a dotli integrator, I build two registries and find a grant in one leaves the other asking', async () => {
    // Given a second registry with no connection for myapp
    const { permissions } = createHarness();
    const other = createPermissionAuthorizations();
    await permissions.setStatus({ label: 'myapp', permission: 'Camera', status: 'granted' });

    // When
    const status = await other.getStatus('myapp', 'Camera');

    // Then
    expect(status).toBe('ask');
  });

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
  it('As a dApp user, I have decided nothing yet and find each permission set to ask', async () => {
    // Given
    const { permissions } = createHarness();

    // When
    const statuses = await Promise.all([
      permissions.getStatus('myapp', 'Camera'),
      permissions.getStatus('myapp', 'ChainSubmit'),
      permissions.getStatus('myapp', 'IdentityDisclosure'),
    ]);

    // Then
    expect(statuses).toEqual(['ask', 'ask', 'ask']);
  });

  it('As a dApp user whose connection answers fewer statuses than asked, I read a permission and the missing status reads as ask', async () => {
    // Given a provider that violates the length contract
    const { permissions } = createHarness();
    onTestFinished(
      permissions.register('shortapp', {
        getPermissionAuthorizationStatuses() {
          return Promise.resolve([]);
        },
        setPermissionAuthorizationStatus() {
          return Promise.resolve();
        },
      }),
    );

    // When
    const status = await permissions.getStatus('shortapp', 'Camera');

    // Then the missing entry surfaces as "ask", not undefined
    expect(status).toBe('ask');
  });

  it('As a dApp user, I decide my permissions and find them in the core authorization store', async () => {
    // Given
    const { permissions, store } = createHarness();
    const before = new Map(store);

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
    expect(before).toEqual(new Map());
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

  it('As a dApp user whose app fails to move to a replacement connection, I read my grant and the active connection still answers', async () => {
    // Given
    const { permissions, registerStore } = createHarness();
    await permissions.setStatus({ label: 'myapp', permission: 'Camera', status: 'granted' });
    const unregisterReplacement = registerStore('myapp', new Map([['Device:Camera', 'Denied']]));

    // When the replacement answers, then goes
    const whileReplaced = await permissions.getStatus('myapp', 'Camera');
    unregisterReplacement();
    const afterReplacement = await permissions.getStatus('myapp', 'Camera');

    // Then
    expect([whileReplaced, afterReplacement]).toEqual(['denied', 'granted']);
  });
});

describe('getGrantedDevicePermissions', () => {
  it('As a dApp user, I grant some permissions and my app frame receives only the granted device ones', async () => {
    // Given
    const { permissions } = createHarness();
    await permissions.setStatus({ label: 'myapp', permission: 'Camera', status: 'granted' });
    await permissions.setStatus({ label: 'myapp', permission: 'Microphone', status: 'denied' });
    await permissions.setStatus({ label: 'myapp', permission: 'ChainSubmit', status: 'granted' });
    await permissions.setStatus({ label: 'myapp', permission: 'IdentityDisclosure', status: 'granted' });

    // When
    const granted = await permissions.getGrantedDevicePermissions('myapp');

    // Then
    expect(granted).toEqual(['Camera']);
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
    // Order follows JSON insertion order, so assert on the directive set.
    const directives = (await permissions.getAllowAttribute('myapp')).split('; ').sort();

    // Then
    expect(directives).toEqual(['camera', 'clipboard-write', 'display-capture', 'microphone']);
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
