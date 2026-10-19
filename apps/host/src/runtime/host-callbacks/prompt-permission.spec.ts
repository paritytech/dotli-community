// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProductContext } from '@parity/truapi-host';
import type { PermissionAuthorizationRequest, PermissionAuthorizationStatus } from '@parity/truapi-host';
import { createPermissionAuthorizations, type PermissionAuthorizations } from '../permissions.js';
import {
  createProductPermissions,
  type PermissionsChange,
  type ProductPermissions,
} from '../state/product-permissions.js';
import { productStore } from '../state/product.js';
import { createBlockingModalCoordinator } from '../blocking-modal-queue.js';
import { createPromptPermission } from './prompt-permission.js';
import type { PermissionPromptDecision } from '../host-prompts.js';
import { createFakePrompts, type FakePrompts } from '../host-prompts.fake.js';

const PRODUCT: ProductContext = {
  productId: 'myapp.paseo',
  executionKind: 'App',
};

let page: FakePrompts = createFakePrompts();
// Each test builds its own registry and store, so no registration carries over.
let registry: PermissionAuthorizations;
let store: ProductPermissions;

/** The prompt adapters for `label`, over the fake prompts and this test's permissions. */
function prompts(
  label = 'myapp',
  scope = createBlockingModalCoordinator().createScope(),
): ReturnType<typeof createPromptPermission> {
  return createPromptPermission(
    label,
    {
      ask: page.prompts.askPermission,
      notify: page.prompts.notify,
      permissions: { registry, product: store },
    },
    scope,
  );
}

type Store = Map<string, PermissionAuthorizationStatus>;

let unregisterMyapp: (() => void) | null = null;
let myappStore: Store;

beforeEach(() => {
  registry = createPermissionAuthorizations();
  store = createProductPermissions({ registry, product: productStore });
  myappStore = new Map();
  page = createFakePrompts();
  unregisterMyapp = registerTestProvider('myapp', myappStore);
});

afterEach(() => {
  unregisterMyapp?.();
  unregisterMyapp = null;
});

function registerTestProvider(label: string, store: Store): () => void {
  return registry.register(label, {
    getPermissionAuthorizationStatuses(requests) {
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

describe('device permission prompts', () => {
  async function grantAndRecordChanges(permission: 'Camera' | 'Notifications'): Promise<PermissionsChange[]> {
    const changes: PermissionsChange[] = [];
    const stop = store.onChanged(change => {
      changes.push(change);
    });

    const response = prompts().devicePermission(PRODUCT, permission);
    await clickPromptButton(permission === 'Camera' ? 'Allow' : 'Always allow');
    await expect(response).resolves.toEqual('AllowAlways');

    stop();
    return changes;
  }

  it('As a product, an auto-granted OpenUrl is answered once without a prompt', async () => {
    // When / Then
    await expect(prompts().devicePermission(PRODUCT, 'OpenUrl')).resolves.toBe('AllowOnce');
    expect(page.pending()).toEqual([]);
  });

  it('As a product, a notifications grant is announced as not a device change', async () => {
    // When / Then
    expect(await grantAndRecordChanges('Notifications')).toEqual([
      { label: 'myapp', permissions: ['Notifications'], allowChanged: false, fromPrompt: true },
    ]);
  });

  it('As a product, a camera grant is announced as a device change from the prompt', async () => {
    // When / Then
    expect(await grantAndRecordChanges('Camera')).toEqual([
      { label: 'myapp', permissions: ['Camera'], allowChanged: true, fromPrompt: true },
    ]);
  });
});

describe('three-way permission prompts', () => {
  it('As a dotli user, allowing a transaction once grants only this one', async () => {
    // Given
    const response = prompts().remotePermission(PRODUCT, {
      permission: { tag: 'ChainSubmit' },
    });

    // When
    await clickPromptButton('Allow once');

    // Then
    await expect(response).resolves.toBe('AllowOnce');
    expect(await registry.status('myapp', 'ChainSubmit')).toBe('ask');
  });

  it('As a dotli user, always allowing transactions saves the grant', async () => {
    // Given
    const changes: PermissionsChange[] = [];
    const stop = store.onChanged(change => {
      changes.push(change);
    });
    const response = prompts().remotePermission(PRODUCT, {
      permission: { tag: 'ChainSubmit' },
    });

    // When
    await clickPromptButton('Always allow');

    // Then
    await expect(response).resolves.toBe('AllowAlways');
    expect(await registry.status('myapp', 'ChainSubmit')).toBe('granted');
    expect(changes).toEqual([{ label: 'myapp', permissions: ['ChainSubmit'], allowChanged: false, fromPrompt: true }]);
    stop();
  });

  it('As a dotli user, denying transactions saves the refusal', async () => {
    // Given
    const response = prompts().remotePermission(PRODUCT, {
      permission: { tag: 'ChainSubmit' },
    });

    // When
    await clickPromptButton('Deny');

    // Then
    await expect(response).resolves.toBe('Deny');
    expect(await registry.status('myapp', 'ChainSubmit')).toBe('denied');
  });

  it('As a dotli user, I can allow a single notification', async () => {
    // Given
    const response = prompts().devicePermission(PRODUCT, 'Notifications');

    // When
    await clickPromptButton('Allow once');

    // Then
    await expect(response).resolves.toBe('AllowOnce');
    expect(await registry.status('myapp', 'Notifications')).toBe('ask');
  });

  it('As a dotli user, a camera prompt offers no one-time grant because granting reloads the app', async () => {
    // When
    const response = prompts().devicePermission(PRODUCT, 'Camera');
    await promptShown();

    // Then
    expect(page.shown()).toMatchObject({ kind: 'permission', permission: 'Camera', allowOnce: false });
    await clickPromptButton('Deny');
    await expect(response).resolves.toBe('Deny');
  });

  it('As a product, an existing grant is answered without being upgraded to a lasting one', async () => {
    // Given: the status can reflect a pending one-time grant, so answering
    // AllowAlways here would quietly make it permanent.
    await registry.setStatus('myapp', 'ChainSubmit', 'granted');

    // When
    const response = prompts().remotePermission(PRODUCT, {
      permission: { tag: 'ChainSubmit' },
    });

    // Then
    await expect(response).resolves.toBe('AllowOnce');
    expect(page.pending()).toEqual([]);
  });

  it('As a dotli user, a stored notification denial is answered without a prompt and with a quiet blocked notice', async () => {
    // Given
    await registry.setStatus('myapp', 'Notifications', 'denied');

    // When
    const response = prompts().devicePermission(PRODUCT, 'Notifications');

    // Then
    await expect(response).resolves.toBe('Deny');
    expect(page.pending()).toEqual([]);
    expect(page.notices).toEqual([
      expect.objectContaining({
        text: 'Notifications access is blocked. Use the permissions menu in the top bar to change this.',
        tone: 'idle',
      }),
    ]);
  });

  it('As a dotli user, dismissing a notification prompt records no decision', async () => {
    // Given
    const response = prompts().devicePermission(PRODUCT, 'Notifications');
    await promptShown();

    // When
    page.dismiss();

    // Then
    await expect(response).rejects.toThrow('User dismissed permission dialog');
    expect(await registry.status('myapp', 'Notifications')).toBe('ask');
  });
});

describe('queued permission prompts', () => {
  it('As a product with notifications granted, I get my answer while another dialog is open', async () => {
    // Given a dialog that holds the queue until the user answers it
    await registry.setStatus('myapp', 'Notifications', 'granted');
    const scope = createBlockingModalCoordinator().createScope();
    void scope.enqueue(signal => page.prompts.askPermission('myapp', 'ChainSubmit', signal, { allowOnce: true }));
    await promptShown();

    // When
    const response = prompts('myapp', scope).devicePermission(PRODUCT, 'Notifications');

    // Then
    await expect(response).resolves.toBe('AllowOnce');
    expect(page.shown()).toMatchObject({ permission: 'ChainSubmit' });
    scope.dispose();
  });

  it('As a dotli user with notifications blocked, I am told so while another dialog is open', async () => {
    // Given a dialog that holds the queue until the user answers it
    await registry.setStatus('myapp', 'Notifications', 'denied');
    const scope = createBlockingModalCoordinator().createScope();
    void scope.enqueue(signal => page.prompts.askPermission('myapp', 'ChainSubmit', signal, { allowOnce: true }));
    await promptShown();

    // When
    const response = prompts('myapp', scope).devicePermission(PRODUCT, 'Notifications');

    // Then
    await expect(response).resolves.toBe('Deny');
    expect(page.notices).toEqual([expect.objectContaining({ tone: 'idle' })]);
    scope.dispose();
  });

  it('As a dotli integrator, I queue a duplicate permission prompt and the host rechecks the permission before showing it', async () => {
    // Given
    let status: 'NotDetermined' | 'Authorized' = 'NotDetermined';
    const unregister = registry.register('queued-app', {
      getPermissionAuthorizationStatuses(requests) {
        return Promise.resolve(requests.map(() => status));
      },
      setPermissionAuthorizationStatus(_request, nextStatus) {
        if (nextStatus === 'Authorized' || nextStatus === 'NotDetermined') {
          status = nextStatus;
        }
        return Promise.resolve();
      },
    });
    const scope = createBlockingModalCoordinator().createScope();
    const permissions = prompts('queued-app', scope);

    // When
    const first = permissions.devicePermission(PRODUCT, 'Notifications');
    const second = permissions.devicePermission(PRODUCT, 'Notifications');
    await promptShown();

    // When
    page.decide('granted');

    // Then: the duplicate reads the saved grant instead of prompting, and
    // answers without upgrading what it found.
    await expect(Promise.all([first, second])).resolves.toEqual(['AllowAlways', 'AllowOnce']);
    expect(page.pending()).toEqual([]);
    expect(status).toBe('Authorized');
    scope.dispose();
    unregister();
  });
});

/** Waits for the prompt to come up, after the adapter has read the stored status. */
async function promptShown(): Promise<void> {
  await page.promptShown();
  expect(page.pending()).toHaveLength(1);
}

type PromptButton = 'Deny' | 'Allow' | 'Always allow' | 'Allow once';

const DECISIONS: Record<PromptButton, PermissionPromptDecision> = {
  Deny: 'denied',
  Allow: 'granted',
  'Always allow': 'granted',
  'Allow once': 'granted-once',
};

/** The permission dialog's buttons: a one-time grant splits the lasting one into always and once. */
function offers(allowOnce: boolean, text: PromptButton): boolean {
  return allowOnce ? text !== 'Allow' : text === 'Deny' || text === 'Allow';
}

/** Presses the permission dialog's button with this label, once a prompt that offers it is up. */
async function clickPromptButton(text: PromptButton): Promise<void> {
  await page.promptShown(prompt => prompt.kind === 'permission' && offers(prompt.allowOnce, text));
  page.decide(DECISIONS[text]);
}
