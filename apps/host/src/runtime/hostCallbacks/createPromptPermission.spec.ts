// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { asProductId } from '@parity/truapi';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import type { ProductContext } from '@parity/truapi-host';
import type { PermissionAuthorizationRequest, PermissionAuthorizationStatus } from '@parity/truapi-host';
import { createPermissionAuthorizations, type PermissionAuthorizations } from '../createPermissionAuthorizations.js';
import {
  createProductPermissions,
  type PermissionsChange,
  type ProductPermissions,
} from '../state/productPermissions.js';
import { productState } from '../state/productState.js';
import { createBlockingModalCoordinator, type BlockingModalScope } from '../createBlockingModalCoordinator.js';
import { createPromptPermission } from './createPromptPermission.js';
import type { PermissionPromptDecision } from '../hostPrompts.js';
import { createFakePrompts, type FakePrompts } from '../hostPrompts.fake.js';

type Params = {
  /** The product the prompts speak for, `myapp` by default. */
  label?: string;
  /** Where the prompts queue, a scope of a new coordinator by default. */
  scope?: BlockingModalScope;
};

type Store = Map<string, PermissionAuthorizationStatus>;

type PromptButton = 'Deny' | 'Allow' | 'Always allow' | 'Allow once';

const PRODUCT: ProductContext = {
  productId: asProductId('myapp.paseo'),
  executionKind: 'App',
};

const DECISIONS: Record<PromptButton, PermissionPromptDecision> = {
  Deny: 'denied',
  Allow: 'granted',
  'Always allow': 'granted',
  'Allow once': 'granted-once',
};

let page: FakePrompts = createFakePrompts();
// Each test builds its own registry and store, so no registration carries over.
let registry: PermissionAuthorizations;
let store: ProductPermissions;
let unregisterMyapp: (() => void) | null = null;
let myappStore: Store;

beforeEach(() => {
  registry = createPermissionAuthorizations();
  store = createProductPermissions({ registry, product: productState.store });
  myappStore = new Map();
  page = createFakePrompts();
  unregisterMyapp = registerTestProvider('myapp', myappStore);
});

afterEach(() => {
  unregisterMyapp?.();
  unregisterMyapp = null;
});

describe('device permission prompts', () => {
  it('As a product developer, I ask for OpenUrl and it is granted once without a prompt', async () => {
    // Given a product with no stored permissions and no prompt on show

    // When
    const answer = await createPrompts().devicePermission(PRODUCT, 'OpenUrl');

    // Then
    expect(answer).toBe('AllowOnce');
    expect(page.listPending()).toEqual([]);
  });

  it.each<{ permission: 'Camera' | 'Notifications'; button: PromptButton; announced: string; allowChanged: boolean }>([
    { permission: 'Notifications', button: 'Always allow', announced: 'not a device change', allowChanged: false },
    { permission: 'Camera', button: 'Allow', announced: 'a device change', allowChanged: true },
  ])(
    'As a product developer, I get $permission granted from the prompt and the grant is announced as $announced',
    async ({ permission, button, allowChanged }) => {
      // Given
      const changes = recordChanges();

      // When
      const response = createPrompts().devicePermission(PRODUCT, permission);
      await clickPromptButton(button);
      const answer = await response;

      // Then
      expect(answer).toBe('AllowAlways');
      expect(changes).toEqual([{ label: 'myapp', permissions: [permission], allowChanged, fromPrompt: true }]);
    },
  );
});

describe('three-way permission prompts', () => {
  it.each<{ button: PromptButton; answer: string; status: string; changes: PermissionsChange[] }>([
    { button: 'Allow once', answer: 'AllowOnce', status: 'ask', changes: [] },
    {
      button: 'Always allow',
      answer: 'AllowAlways',
      status: 'granted',
      changes: [{ label: 'myapp', permissions: ['ChainSubmit'], allowChanged: false, fromPrompt: true }],
    },
    {
      button: 'Deny',
      answer: 'Deny',
      status: 'denied',
      changes: [{ label: 'myapp', permissions: ['ChainSubmit'], allowChanged: false, fromPrompt: true }],
    },
  ])(
    'As a user, I press $button on a transaction prompt and the product hears $answer while the stored status is $status',
    async ({ button, answer, status, changes }) => {
      // Given
      const recorded = recordChanges();
      const response = createPrompts().remotePermission(PRODUCT, {
        permission: { tag: 'ChainSubmit' },
      });

      // When
      await clickPromptButton(button);
      const heard = await response;
      const stored = await registry.getStatus('myapp', 'ChainSubmit');

      // Then
      expect({ heard, stored, recorded }).toEqual({ heard: answer, stored: status, recorded: changes });
    },
  );

  it('As a user, I allow a single notification and only that one is granted', async () => {
    // Given
    const response = createPrompts().devicePermission(PRODUCT, 'Notifications');

    // When
    await clickPromptButton('Allow once');
    const answer = await response;
    const stored = await registry.getStatus('myapp', 'Notifications');

    // Then
    expect(answer).toBe('AllowOnce');
    expect(stored).toBe('ask');
  });

  it('As a user, I see a camera prompt and it offers no one-time grant because granting reloads the app', async () => {
    // Given a product with no stored camera permission

    // When
    const response = createPrompts().devicePermission(PRODUCT, 'Camera');
    await page.waitForPrompt();
    const shown = page.getShown();

    // Then
    expect(shown).toMatchObject({ kind: 'permission', permission: 'Camera', allowOnce: false });
    expect(page.listPending()).toHaveLength(1);

    // When
    await clickPromptButton('Deny');

    // Then
    await expect(response).resolves.toBe('Deny');
  });

  it('As a product developer, I ask with an existing grant and get it answered without a lasting upgrade', async () => {
    // Given the status can reflect a pending one-time grant, so answering
    // AllowAlways here would quietly make it permanent
    await registry.setStatus({ label: 'myapp', permission: 'ChainSubmit', status: 'granted' });

    // When
    const response = createPrompts().remotePermission(PRODUCT, {
      permission: { tag: 'ChainSubmit' },
    });

    // Then
    await expect(response).resolves.toBe('AllowOnce');
    expect(page.listPending()).toEqual([]);
  });

  it('As a user with a stored notification denial, I am asked for notifications and it is denied with a quiet blocked notice and no prompt', async () => {
    // Given
    await registry.setStatus({ label: 'myapp', permission: 'Notifications', status: 'denied' });

    // When
    const response = createPrompts().devicePermission(PRODUCT, 'Notifications');

    // Then
    await expect(response).resolves.toBe('Deny');
    expect(page.listPending()).toEqual([]);
    expect(page.notices).toEqual([
      expect.objectContaining({
        text: 'Notifications access is blocked. Use the permissions menu in the top bar to change this.',
        tone: 'idle',
      }),
    ]);
  });

  it('As a user, I dismiss a notification prompt and no decision is recorded', async () => {
    // Given
    const response = createPrompts().devicePermission(PRODUCT, 'Notifications');
    await page.waitForPrompt();

    // When
    page.dismiss();
    const failure = await response.then(
      () => null,
      (error: unknown) => error,
    );
    const stored = await registry.getStatus('myapp', 'Notifications');

    // Then
    expect(failure).toMatchObject({ message: 'User dismissed permission dialog' });
    expect(stored).toBe('ask');
  });
});

describe('queued permission prompts', () => {
  it('As a product developer with notifications granted, I ask while another dialog is open and get my answer', async () => {
    // Given a dialog that holds the queue until the user answers it
    await registry.setStatus({ label: 'myapp', permission: 'Notifications', status: 'granted' });
    const scope = createBlockingModalCoordinator().createScope();
    const held = scope.enqueue(signal =>
      page.prompts.askPermission({ label: 'myapp', permission: 'ChainSubmit', signal, allowOnce: true }),
    );
    await page.waitForPrompt();

    // When
    const response = createPrompts({ scope }).devicePermission(PRODUCT, 'Notifications');

    // Then
    await expect(response).resolves.toBe('AllowOnce');
    expect(page.getShown()).toMatchObject({ permission: 'ChainSubmit' });

    // When the queue's scope goes
    scope.dispose();

    // Then the dialog that held it ends with it
    await expect(held).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('As a user with notifications blocked, I am asked while another dialog is open and am told so', async () => {
    // Given a dialog that holds the queue until the user answers it
    await registry.setStatus({ label: 'myapp', permission: 'Notifications', status: 'denied' });
    const scope = createBlockingModalCoordinator().createScope();
    const held = scope.enqueue(signal =>
      page.prompts.askPermission({ label: 'myapp', permission: 'ChainSubmit', signal, allowOnce: true }),
    );
    await page.waitForPrompt();

    // When
    const response = createPrompts({ scope }).devicePermission(PRODUCT, 'Notifications');

    // Then
    await expect(response).resolves.toBe('Deny');
    expect(page.notices).toEqual([expect.objectContaining({ tone: 'idle' })]);

    // When the queue's scope goes
    scope.dispose();

    // Then the dialog that held it ends with it
    await expect(held).rejects.toMatchObject({ name: 'AbortError' });
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
    onTestFinished(() => {
      scope.dispose();
      unregister();
    });
    const permissions = createPrompts({ label: 'queued-app', scope });

    // When the same permission is asked twice and the user grants the first prompt
    const first = permissions.devicePermission(PRODUCT, 'Notifications');
    const second = permissions.devicePermission(PRODUCT, 'Notifications');
    await page.waitForPrompt();
    page.decide('granted');

    // Then the duplicate reads the saved grant instead of prompting, and
    // answers without upgrading what it found
    await expect(Promise.all([first, second])).resolves.toEqual(['AllowAlways', 'AllowOnce']);
    expect(page.listPending()).toEqual([]);
    expect(status).toBe('Authorized');
  });
});

/** The prompt adapters over the fake prompts and this test's permissions. */
function createPrompts({
  label = 'myapp',
  scope = createBlockingModalCoordinator().createScope(),
}: Params = {}): ReturnType<typeof createPromptPermission> {
  return createPromptPermission({
    label,
    ask: page.prompts.askPermission,
    notify: page.prompts.notify,
    permissions: { registry, product: store },
    modalScope: scope,
  });
}

/** Records every change the product's permissions announce until the test finishes. */
function recordChanges(): PermissionsChange[] {
  const changes: PermissionsChange[] = [];
  onTestFinished(
    store.subscribeChanges(change => {
      changes.push(change);
    }),
  );
  return changes;
}

function registerTestProvider(label: string, statuses: Store): () => void {
  return registry.register(label, {
    getPermissionAuthorizationStatuses(requests) {
      return Promise.resolve(requests.map(request => statuses.get(getRequestKey(request)) ?? 'NotDetermined'));
    },
    setPermissionAuthorizationStatus(request, status) {
      const key = getRequestKey(request);
      if (status === 'NotDetermined') {
        statuses.delete(key);
      } else {
        statuses.set(key, status);
      }
      return Promise.resolve();
    },
  });
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

/** The permission dialog's buttons: a one-time grant splits the lasting one into always and once. */
function isOffered(allowOnce: boolean, text: PromptButton): boolean {
  return allowOnce ? text !== 'Allow' : text === 'Deny' || text === 'Allow';
}

/** Presses the permission dialog's button with this label, once a prompt that offers it is up. */
async function clickPromptButton(text: PromptButton): Promise<void> {
  await page.waitForPrompt({ matches: prompt => prompt.kind === 'permission' && isOffered(prompt.allowOnce, text) });
  page.decide(DECISIONS[text]);
}
