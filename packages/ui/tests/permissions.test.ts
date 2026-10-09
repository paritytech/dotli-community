// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductContext } from '@parity/truapi-host';
import {
  ALL_PERMISSIONS,
  AUTO_GRANT_DEVICE_PERMISSIONS,
  DEVICE_PERMISSION_POLICY,
  buildAllowAttribute,
  getGrantedDevicePermissions,
  getPermissionStatuses,
  getPermissionStatus,
  hasAnyGrant,
  isDevicePermission,
  isEnforceableDevicePermission,
  registerPermissionAuthorizationProvider,
  resetAllPermissions,
  resetPermission,
  setPermissionStatus,
} from '../src/permissions.js';
import type { PermissionAuthorizationRequest, PermissionAuthorizationStatus } from '@parity/truapi-host';
import { createPromptPermission, decidePromptPermission } from '../src/host-callbacks/PromptPermission.js';
import { overlaysReady, resetOverlays } from './helpers/overlays.js';
import { byTestId } from './support.js';

const PRODUCT: ProductContext = {
  productId: 'myapp.paseo',
  executionKind: 'App',
};

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
  resetOverlays();
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

  it('As a product, my granted permission status is preserved', async () => {
    await setPermissionStatus('myapp', 'Camera', 'granted');
    expect(await getPermissionStatus('myapp', 'Camera')).toBe('granted');
  });

  it('As a product, my denied permission status is preserved', async () => {
    await setPermissionStatus('myapp', 'ChainSubmit', 'denied');
    expect(await getPermissionStatus('myapp', 'ChainSubmit')).toBe('denied');
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
    await setPermissionStatus('myapp', 'Camera', 'granted');
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

describe('resetPermission', () => {
  it('As a product, I can reset one permission without affecting my others', async () => {
    // Given
    await setPermissionStatus('myapp', 'Camera', 'granted');
    await setPermissionStatus('myapp', 'ChainSubmit', 'granted');

    // When
    await resetPermission('myapp', 'Camera');

    // Then
    expect(await getPermissionStatus('myapp', 'Camera')).toBe('ask');
    expect(await getPermissionStatus('myapp', 'ChainSubmit')).toBe('granted');
  });

  it('As a product, resetting an unknown permission leaves my grants unchanged', async () => {
    await resetPermission('myapp', 'Camera');
    expect(await getPermissionStatus('myapp', 'Camera')).toBe('ask');
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
    expect(result).toEqual({ reset: ['Notifications', 'Camera', 'ChainSubmit'], failed: false });
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
      expect(result).toEqual({ reset: [], failed: false });
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
      expect(result).toEqual({ reset: ['Microphone'], failed: true });
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
    expect(result).toEqual({ reset: [], failed: false });
  });
});

describe('hasAnyGrant', () => {
  it('As a new product, I have no persisted grants', async () => {
    expect(await hasAnyGrant('myapp')).toBe(false);
  });

  it('As a product, I have persisted grants after one permission is allowed', async () => {
    await setPermissionStatus('myapp', 'IdentityDisclosure', 'granted');
    expect(await hasAnyGrant('myapp')).toBe(true);
  });

  it('As a product, denied permissions do not count as persisted grants', async () => {
    await setPermissionStatus('myapp', 'Camera', 'denied');
    await setPermissionStatus('myapp', 'ChainSubmit', 'denied');
    await setPermissionStatus('myapp', 'IdentityDisclosure', 'denied');
    expect(await hasAnyGrant('myapp')).toBe(false);
  });

  it('As a product, I have no persisted grants after resetting my only grant', async () => {
    // Given
    await setPermissionStatus('myapp', 'Camera', 'granted');

    // When
    await resetPermission('myapp', 'Camera');

    // Then
    expect(await hasAnyGrant('myapp')).toBe(false);
  });
});

describe('isDevicePermission', () => {
  it('identifies entries in DEVICE_PERMISSION_POLICY', () => {
    expect(isDevicePermission('Camera')).toBe(true);
    expect(isDevicePermission('Microphone')).toBe(true);
    expect(isDevicePermission('Bluetooth')).toBe(true);
    expect(isDevicePermission('Location')).toBe(true);
    expect(isDevicePermission('Clipboard')).toBe(true);
    expect(isDevicePermission('Biometrics')).toBe(true);
    expect(isDevicePermission('NFC')).toBe(true);
  });

  it('rejects submit-style permissions', () => {
    expect(isDevicePermission('ChainSubmit')).toBe(false);
    expect(isDevicePermission('PreimageSubmit')).toBe(false);
    expect(isDevicePermission('StatementSubmit')).toBe(false);
    expect(isDevicePermission('IdentityDisclosure')).toBe(false);
  });

  it('rejects device permissions absent from the policy map', () => {
    // Notifications is host-gated separately but has no Permissions Policy directive. OpenUrl is auto-granted.
    expect(isDevicePermission('Notifications')).toBe(false);
    expect(isDevicePermission('OpenUrl')).toBe(false);
  });
});

describe('isEnforceableDevicePermission', () => {
  it('rejects auto-granted device permissions', () => {
    expect(isEnforceableDevicePermission('OpenUrl')).toBe(false);
  });

  it('accepts gateable device permissions', () => {
    expect(isEnforceableDevicePermission('Notifications')).toBe(true);
    expect(isEnforceableDevicePermission('Camera')).toBe(true);
    expect(isEnforceableDevicePermission('Microphone')).toBe(true);
  });
});

describe('device permission prompts', () => {
  async function grantAndCountReloads(permission: 'Camera' | 'Notifications'): Promise<number> {
    let reloads = 0;
    const onReload = (): void => {
      reloads += 1;
    };
    window.addEventListener('dotli:device-permission-changed', onReload);

    const response = createPromptPermission('myapp').devicePermission(PRODUCT, permission);
    await clickPromptButton(permission === 'Camera' ? 'Allow' : 'Always allow');
    await expect(response).resolves.toEqual('AllowAlways');
    await new Promise(resolve => setTimeout(resolve, 0));

    window.removeEventListener('dotli:device-permission-changed', onReload);
    document.body.replaceChildren();
    return reloads;
  }

  it('As a product, an auto-granted OpenUrl is answered once without a prompt', async () => {
    await expect(createPromptPermission('myapp').devicePermission(PRODUCT, 'OpenUrl')).resolves.toBe('AllowOnce');
    expect(document.querySelector('[data-testid="signing-modal-backdrop"]')).toBeNull();
  });

  it('As a product, my iframe stays alive when notifications are granted', async () => {
    expect(await grantAndCountReloads('Notifications')).toBe(0);
  });

  it('As a product, my iframe reloads when a grant changes its allow attribute', async () => {
    expect(await grantAndCountReloads('Camera')).toBe(1);
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

  it('As a product, submit permissions do not alter my iframe policy', async () => {
    // Given
    await setPermissionStatus('myapp', 'ChainSubmit', 'granted');
    await setPermissionStatus('myapp', 'PreimageSubmit', 'granted');

    // When
    const permissions = await getGrantedDevicePermissions('myapp');

    // Then
    expect(permissions).toEqual([]);
  });
});

describe('buildAllowAttribute', () => {
  it('As a product, my iframe always receives clipboard-write access', async () => {
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
  it('only references EnforceablePermissionName values', () => {
    for (const { name } of ALL_PERMISSIONS) {
      expect(AUTO_GRANT_DEVICE_PERMISSIONS.has(name as never)).toBe(false);
    }
  });

  it('uses the canonical v0.7 wire tags for submit gates', () => {
    const names = ALL_PERMISSIONS.map(p => p.name);
    expect(names).toContain('ChainSubmit');
    expect(names).toContain('IdentityDisclosure');
    expect(names).toContain('PreimageSubmit');
    expect(names).toContain('StatementSubmit');
    expect(names).toContain('Notifications');
    expect(names).not.toContain('TransactionSubmit');
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
  it('does not list auto-granted device permissions', () => {
    for (const auto of AUTO_GRANT_DEVICE_PERMISSIONS) {
      expect(auto in DEVICE_PERMISSION_POLICY).toBe(false);
    }
  });
});

describe('three-way permission prompts', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('As a dotli user, allowing a transaction once grants only this one', async () => {
    // Given
    const response = createPromptPermission('myapp').remotePermission(PRODUCT, {
      permission: { tag: 'ChainSubmit' },
    });

    // When
    await clickPromptButton('Allow once');

    // Then
    await expect(response).resolves.toBe('AllowOnce');
    expect(await getPermissionStatus('myapp', 'ChainSubmit')).toBe('ask');
  });

  it('As a dotli user, always allowing transactions saves the grant', async () => {
    // Given
    const events: unknown[] = [];
    const onPermissionChanged = (e: Event): void => {
      events.push((e as CustomEvent).detail);
    };
    window.addEventListener('dotli:permission-changed', onPermissionChanged);
    const response = createPromptPermission('myapp').remotePermission(PRODUCT, {
      permission: { tag: 'ChainSubmit' },
    });

    // When
    await clickPromptButton('Always allow');

    // Then
    await expect(response).resolves.toBe('AllowAlways');
    expect(await getPermissionStatus('myapp', 'ChainSubmit')).toBe('granted');
    expect(events).toEqual([{ label: 'myapp', permission: 'ChainSubmit' }]);
    window.removeEventListener('dotli:permission-changed', onPermissionChanged);
  });

  it('As a dotli user, denying transactions saves the refusal', async () => {
    // Given
    const response = createPromptPermission('myapp').remotePermission(PRODUCT, {
      permission: { tag: 'ChainSubmit' },
    });

    // When
    await clickPromptButton('Deny');

    // Then
    await expect(response).resolves.toBe('Deny');
    expect(await getPermissionStatus('myapp', 'ChainSubmit')).toBe('denied');
  });

  it('As a dotli user, I can allow a single notification', async () => {
    // Given
    const response = createPromptPermission('myapp').devicePermission(PRODUCT, 'Notifications');

    // When
    await clickPromptButton('Allow once');

    // Then
    await expect(response).resolves.toBe('AllowOnce');
    expect(await getPermissionStatus('myapp', 'Notifications')).toBe('ask');
  });

  it('As a dotli user, a camera prompt offers no one-time grant because granting reloads the app', async () => {
    // When
    const response = createPromptPermission('myapp').devicePermission(PRODUCT, 'Camera');
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="signing-modal-footer"]')).not.toBeNull();
    });

    // Then
    expect(promptButtonTexts()).toEqual(['Deny', 'Allow']);
    await clickPromptButton('Deny');
    await expect(response).resolves.toBe('Deny');
  });

  it('As a mediated camera user, I can allow one scan without making the grant durable', async () => {
    const response = decidePromptPermission('myapp', 'Camera', {
      kind: 'Device',
      limiter: { allow: () => true },
      gatedByIframe: false,
    });

    await clickPromptButton('Allow once');

    await expect(response).resolves.toBe('AllowOnce');
    expect(await getPermissionStatus('myapp', 'Camera')).toBe('ask');
  });

  it('As a product, an existing grant is answered without being upgraded to a lasting one', async () => {
    // Given: the status can reflect a pending one-time grant, so answering
    // AllowAlways here would quietly make it permanent.
    await setPermissionStatus('myapp', 'ChainSubmit', 'granted');

    // When
    const response = createPromptPermission('myapp').remotePermission(PRODUCT, {
      permission: { tag: 'ChainSubmit' },
    });

    // Then
    await expect(response).resolves.toBe('AllowOnce');
    expect(document.querySelector('[data-testid="signing-modal-backdrop"]')).toBeNull();
  });

  it('As a dotli user, a stored notification denial is answered without a prompt and with a quiet blocked notice', async () => {
    // Given
    await setPermissionStatus('myapp', 'Notifications', 'denied');

    // When
    const response = createPromptPermission('myapp').devicePermission(PRODUCT, 'Notifications');

    // Then
    await expect(response).resolves.toBe('Deny');
    expect(document.querySelector('[data-testid="signing-modal-backdrop"]')).toBeNull();
    await overlaysReady();
    expect(document.body.textContent).toContain(
      'Notifications access is blocked. Use the permissions menu in the top bar to change this.',
    );
    expect(byTestId('notif-icon').getAttribute('data-tone')).toBe('idle');
  });

  it('As a dotli user, dismissing a notification prompt records no decision', async () => {
    // Given
    const response = createPromptPermission('myapp').devicePermission(PRODUCT, 'Notifications');
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="signing-modal-backdrop"]')).not.toBeNull();
    });

    // When
    byTestId('signing-modal-backdrop').click();

    // Then
    await expect(response).rejects.toThrow('User dismissed permission dialog');
    expect(await getPermissionStatus('myapp', 'Notifications')).toBe('ask');
  });
});

function promptButtonTexts(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-testid="signing-modal-footer"] button'),
    button => button.textContent,
  );
}

async function clickPromptButton(text: string): Promise<void> {
  await overlaysReady();
  await vi.waitFor(() => {
    expect(promptButtonTexts()).toContain(text);
  });
  Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="signing-modal-footer"] button'))
    .find(button => button.textContent === text)
    ?.click();
}
