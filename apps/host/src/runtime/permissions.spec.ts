// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_PERMISSIONS,
  AUTO_GRANT_DEVICE_PERMISSIONS,
  DEVICE_PERMISSION_POLICY,
  buildAllowAttribute,
  getGrantedDevicePermissions,
  getPermissionStatuses,
  getPermissionStatus,
  isDevicePermission,
  isEnforceableDevicePermission,
  registerPermissionAuthorizationProvider,
  resetAllPermissions,
  setPermissionStatus,
} from './permissions.js';
import type { PermissionAuthorizationRequest, PermissionAuthorizationStatus } from '@parity/truapi-host';

type Store = Map<string, PermissionAuthorizationStatus>;

let unregisterMyapp: (() => void) | null = null;
let myappStore: Store;
let myappBatchReads = 0;

beforeEach(() => {
  myappStore = new Map();
  myappBatchReads = 0;
  unregisterMyapp = registerTestProvider('myapp', myappStore);
});

afterEach(() => {
  unregisterMyapp?.();
  unregisterMyapp = null;
});

function registerTestProvider(label: string, store: Store): () => void {
  return registerPermissionAuthorizationProvider(label, {
    getPermissionAuthorizationStatuses(requests) {
      if (label === 'myapp') {
        myappBatchReads += 1;
      }
      return Promise.resolve(requests.map(request => store.get(requestKey(request)) ?? 'NotDetermined'));
    },
    setPermissionAuthorizationStatus(request, status) {
      const key = requestKey(request);
      if (status === 'NotDetermined') {
        store.delete(key);
      } else {
        store.set(key, status);
      }
      return Promise.resolve();
    },
  });
}

function requestKey(request: PermissionAuthorizationRequest): string {
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

describe('getPermissionStatus / setPermissionStatus', () => {
  it('As a product, my permissions default to ask', async () => {
    // When / Then
    expect(await getPermissionStatus('myapp', 'Camera')).toBe('ask');
    expect(await getPermissionStatus('myapp', 'ChainSubmit')).toBe('ask');
    expect(await getPermissionStatus('myapp', 'IdentityDisclosure')).toBe('ask');
  });

  it('As a product, my status defaults to ask when the provider returns fewer statuses than requested', async () => {
    // Given: a provider that violates the length contract.
    const unregister = registerPermissionAuthorizationProvider('shortapp', {
      getPermissionAuthorizationStatuses() {
        return Promise.resolve([]);
      },
      setPermissionAuthorizationStatus() {
        return Promise.resolve();
      },
    });

    try {
      // Then: the missing entry surfaces as "ask", not undefined.
      expect(await getPermissionStatus('shortapp', 'Camera')).toBe('ask');
    } finally {
      unregister();
    }
  });

  it('As a product, my permission decisions use the core authorization store', async () => {
    // Given
    expect(myappStore).toEqual(new Map());

    // When
    await setPermissionStatus('myapp', 'ChainSubmit', 'granted');
    await setPermissionStatus('myapp', 'Camera', 'denied');
    await setPermissionStatus('myapp', 'IdentityDisclosure', 'granted');

    // Then
    expect(myappStore).toEqual(
      new Map([
        ['Remote:ChainSubmit', 'Authorized'],
        ['Device:Camera', 'Denied'],
        ['IdentityDisclosure', 'Authorized'],
      ]),
    );
    expect(await getPermissionStatus('myapp', 'ChainSubmit')).toBe('granted');
    expect(await getPermissionStatus('myapp', 'Camera')).toBe('denied');
    expect(await getPermissionStatus('myapp', 'IdentityDisclosure')).toBe('granted');
  });

  it('As a product, my permission statuses are read in one provider call', async () => {
    // Given
    await setPermissionStatus('myapp', 'ChainSubmit', 'granted');
    await setPermissionStatus('myapp', 'Camera', 'denied');
    const callsBeforeRead = myappBatchReads;

    // When
    const statuses = getPermissionStatuses('myapp', ['ChainSubmit', 'Camera', 'Microphone']);

    // Then
    await expect(statuses).resolves.toEqual(['granted', 'denied', 'ask']);
    expect(myappBatchReads - callsBeforeRead).toBe(1);
  });

  it('As a product, my permission grants are isolated from other products', async () => {
    // Given
    await setPermissionStatus('myapp', 'Camera', 'granted');

    // When / Then
    expect(await getPermissionStatus('otherapp', 'Camera')).toBe('ask');
  });

  it('As a product, my active permission provider survives a failed replacement', async () => {
    // Given
    await setPermissionStatus('myapp', 'Camera', 'granted');
    const replacementStore: Store = new Map([['Device:Camera', 'Denied']]);
    const unregisterReplacement = registerTestProvider('myapp', replacementStore);

    // Then
    expect(await getPermissionStatus('myapp', 'Camera')).toBe('denied');

    // When
    unregisterReplacement();

    // Then
    expect(await getPermissionStatus('myapp', 'Camera')).toBe('granted');
  });
});

describe('resetAllPermissions', () => {
  it('As a user, Reset all to Ask sets every granted and denied permission of my app back to ask and reports them in menu order', async () => {
    // Given
    await setPermissionStatus('myapp', 'ChainSubmit', 'denied');
    await setPermissionStatus('myapp', 'Camera', 'granted');
    await setPermissionStatus('myapp', 'Notifications', 'granted');

    // When
    const result = await resetAllPermissions('myapp');

    // Then
    expect(result).toEqual({ reset: ['Notifications', 'Camera', 'ChainSubmit'], errors: [] });
    expect(
      await getPermissionStatuses(
        'myapp',
        ALL_PERMISSIONS.map(({ name }) => name),
      ),
    ).toEqual(ALL_PERMISSIONS.map(() => 'ask'));
    expect(myappStore).toEqual(new Map());
  });

  it("As a user, Reset all to Ask leaves other apps' permissions alone", async () => {
    // Given
    const unregister = registerTestProvider('other', new Map());
    try {
      await setPermissionStatus('other', 'Camera', 'granted');
      await setPermissionStatus('myapp', 'Camera', 'granted');

      // When
      await resetAllPermissions('myapp');

      // Then
      expect(await getPermissionStatus('other', 'Camera')).toBe('granted');
      expect(await getPermissionStatus('myapp', 'Camera')).toBe('ask');
    } finally {
      unregister();
    }
  });

  it('As a user with nothing granted or denied, Reset all to Ask writes nothing', async () => {
    // Given
    const set = vi.fn(() => Promise.resolve());
    const unregister = registerPermissionAuthorizationProvider('quiet', {
      getPermissionAuthorizationStatuses: requests => Promise.resolve(requests.map(() => 'NotDetermined' as const)),
      setPermissionAuthorizationStatus: set,
    });
    try {
      // When
      const result = await resetAllPermissions('quiet');

      // Then
      expect(result).toEqual({ reset: [], errors: [] });
      expect(set).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('As a user, a write that fails keeps that permission as it was and is reported, while the others are reset', async () => {
    // Given: the core refuses to change the camera.
    const store = new Map<string, PermissionAuthorizationStatus>([
      ['Device:Camera', 'Authorized'],
      ['Device:Microphone', 'Denied'],
    ]);
    const unregister = registerPermissionAuthorizationProvider('flaky', {
      getPermissionAuthorizationStatuses: requests =>
        Promise.resolve(requests.map(request => store.get(requestKey(request)) ?? 'NotDetermined')),
      setPermissionAuthorizationStatus: (request, status) => {
        const key = requestKey(request);
        if (key === 'Device:Camera') {
          return Promise.reject(new Error('core down'));
        }
        if (status === 'NotDetermined') {
          store.delete(key);
        } else {
          store.set(key, status);
        }
        return Promise.resolve();
      },
    });
    try {
      // When
      const result = await resetAllPermissions('flaky');

      // Then
      expect(result).toEqual({ reset: ['Microphone'], errors: [new Error('core down')] });
      expect(store).toEqual(new Map([['Device:Camera', 'Authorized']]));
    } finally {
      unregister();
    }
  });

  it('As a user whose permissions cannot be read, Reset all to Ask rejects and writes nothing', async () => {
    // Given
    const set = vi.fn(() => Promise.resolve());
    const unregister = registerPermissionAuthorizationProvider('unreadable', {
      getPermissionAuthorizationStatuses: () => Promise.reject(new Error('core down')),
      setPermissionAuthorizationStatus: set,
    });
    try {
      // When
      const result = resetAllPermissions('unreadable');

      // Then
      await expect(result).rejects.toThrow('core down');
      expect(set).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('As a product without a permission provider, Reset all to Ask has nothing to reset', async () => {
    // When
    const result = await resetAllPermissions('nobody');

    // Then
    expect(result).toEqual({ reset: [], errors: [] });
  });
});

describe('isDevicePermission', () => {
  it('As the host gating a product frame, I treat every permission with a Permissions Policy directive as a device permission', () => {
    // When / Then
    expect(isDevicePermission('Camera')).toBe(true);
    expect(isDevicePermission('Microphone')).toBe(true);
    expect(isDevicePermission('Bluetooth')).toBe(true);
    expect(isDevicePermission('Location')).toBe(true);
    expect(isDevicePermission('Clipboard')).toBe(true);
    expect(isDevicePermission('Biometrics')).toBe(true);
    expect(isDevicePermission('NFC')).toBe(true);
  });

  it('As the host gating a product frame, I do not treat submit and disclosure permissions as device permissions', () => {
    // When / Then
    expect(isDevicePermission('ChainSubmit')).toBe(false);
    expect(isDevicePermission('PreimageSubmit')).toBe(false);
    expect(isDevicePermission('StatementSubmit')).toBe(false);
    expect(isDevicePermission('IdentityDisclosure')).toBe(false);
  });

  it('As the host gating a product frame, I do not treat a permission without a Permissions Policy directive as a device permission', () => {
    // When / Then
    // Notifications is host-gated separately but has no Permissions Policy directive. OpenUrl is auto-granted.
    expect(isDevicePermission('Notifications')).toBe(false);
    expect(isDevicePermission('OpenUrl')).toBe(false);
  });
});

describe('isEnforceableDevicePermission', () => {
  it('As the host gating a product frame, I do not enforce an auto-granted device permission', () => {
    // When / Then
    expect(isEnforceableDevicePermission('OpenUrl')).toBe(false);
  });

  it('As the host gating a product frame, I enforce the device permissions a user can be asked for', () => {
    // When / Then
    expect(isEnforceableDevicePermission('Notifications')).toBe(true);
    expect(isEnforceableDevicePermission('Camera')).toBe(true);
    expect(isEnforceableDevicePermission('Microphone')).toBe(true);
  });
});

describe('getGrantedDevicePermissions', () => {
  it('As a product, my iframe receives only granted device permissions', async () => {
    // Given
    await setPermissionStatus('myapp', 'Camera', 'granted');
    await setPermissionStatus('myapp', 'Microphone', 'denied');
    await setPermissionStatus('myapp', 'ChainSubmit', 'granted');
    await setPermissionStatus('myapp', 'IdentityDisclosure', 'granted');

    // When
    const permissions = await getGrantedDevicePermissions('myapp');

    // Then
    expect(permissions).toEqual(['Camera']);
  });
});

describe('buildAllowAttribute', () => {
  it('As a product, my iframe always receives clipboard-write access', async () => {
    // When / Then
    expect(await buildAllowAttribute('myapp')).toBe('clipboard-write');
  });

  it('As a product, my granted device permissions appear in iframe policy', async () => {
    // Given
    await setPermissionStatus('myapp', 'Camera', 'granted');
    await setPermissionStatus('myapp', 'Microphone', 'granted');

    // When
    // Order follows JSON insertion order, so assert on the directive set.
    const directives = (await buildAllowAttribute('myapp')).split('; ').sort();

    // Then
    expect(directives).toEqual(['camera', 'clipboard-write', 'microphone']);
  });

  it('As a product, denied and submit permissions stay out of iframe policy', async () => {
    // Given
    await setPermissionStatus('myapp', 'Camera', 'denied');
    await setPermissionStatus('myapp', 'ChainSubmit', 'granted');

    // When
    const allow = await buildAllowAttribute('myapp');

    // Then
    expect(allow).toBe('clipboard-write');
  });
});

describe('ALL_PERMISSIONS (data invariants)', () => {
  it('As the host listing permissions, I list no auto-granted device permission among the ones I ask for', () => {
    // When / Then
    for (const { name } of ALL_PERMISSIONS) {
      expect(AUTO_GRANT_DEVICE_PERMISSIONS.has(name as never)).toBe(false);
    }
  });

  it('As a user, the menu lists the eight device permissions, then the four app permissions', () => {
    // Then
    expect(ALL_PERMISSIONS.filter(({ group }) => group === 'device').map(({ name }) => name)).toEqual([
      'Notifications',
      'Camera',
      'Microphone',
      'Location',
      'Bluetooth',
      'NFC',
      'Clipboard',
      'Biometrics',
    ]);
    expect(ALL_PERMISSIONS.filter(({ group }) => group === 'app').map(({ name }) => name)).toEqual([
      'IdentityDisclosure',
      'ChainSubmit',
      'PreimageSubmit',
      'StatementSubmit',
    ]);
    expect(ALL_PERMISSIONS.map(({ group }) => group)).toEqual([
      ...ALL_PERMISSIONS.slice(0, 8).map(() => 'device'),
      ...ALL_PERMISSIONS.slice(8).map(() => 'app'),
    ]);
  });
});

describe('DEVICE_PERMISSION_POLICY (sanity)', () => {
  it('As the host gating a product frame, I give no Permissions Policy directive to an auto-granted device permission', () => {
    // When / Then
    for (const auto of AUTO_GRANT_DEVICE_PERMISSIONS) {
      expect(auto in DEVICE_PERMISSION_POLICY).toBe(false);
    }
  });
});
