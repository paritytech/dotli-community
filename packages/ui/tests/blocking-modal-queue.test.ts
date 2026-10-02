import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProductContext } from '@parity/truapi-host';
import { createBlockingModalCoordinator } from '../src/blocking-modal-queue.js';
import { createUserConfirmationAdapters } from '../src/host-callbacks/UserConfirmation.js';
import { createPromptPermission } from '../src/host-callbacks/PromptPermission.js';
import { createHostCallbacks } from '../src/host-callbacks/handlers.js';
import { registerPermissionAuthorizationProvider } from '../src/permissions.js';
import { overlaysReady, resetOverlays } from './helpers/overlays.js';
import { byTestId, query } from './support.js';

const PRODUCT: ProductContext = {
  productId: 'myapp.paseo',
  executionKind: 'App',
};

afterEach(() => {
  resetOverlays();
  document.body.replaceChildren();
});

describe('blocking modal queue', () => {
  it('As a dotli integrator, the host serializes user confirmation and device permission prompts', async () => {
    // Given
    const scope = createBlockingModalCoordinator().createScope();
    const callbacks = createHostCallbacks({
      label: 'localhost:3000',
      blockingModalScope: scope,
    });

    // When
    const accountAccess = callbacks.userConfirmation.confirmUserAction({
      tag: 'AccountAccess',
      value: {
        requestingProductId: 'truapi-playground.dot',
        targetProductId: 'other-product.dot',
      },
    });
    const camera = callbacks.permissions.devicePermission(PRODUCT, 'Camera');
    await overlaysReady();

    // Then
    expect(document.querySelectorAll('[data-testid="signing-modal-backdrop"]')).toHaveLength(1);
    expect(query(byTestId('signing-modal'), 'h2').textContent).toBe('Account Access');

    // When
    byTestId('signing-btn-sign').click();

    // Then
    await expect(accountAccess).resolves.toBe(true);
    await overlaysReady();
    await vi.waitFor(() => {
      expect(query(byTestId('signing-modal'), 'h2').textContent).toBe('Permission Request');
    });
    expect(document.querySelectorAll('[data-testid="signing-modal-backdrop"]')).toHaveLength(1);

    // When
    byTestId('signing-btn-sign').click();

    // Then
    await expect(camera).resolves.toEqual('AllowAlways');
    await overlaysReady();
    expect(document.querySelector('[data-testid="signing-modal-backdrop"]')).toBeNull();
    scope.dispose();
  });

  it('As a dotli integrator, the host rechecks permission state before showing a queued duplicate', async () => {
    // Given
    let status: 'NotDetermined' | 'Authorized' = 'NotDetermined';
    const unregister = registerPermissionAuthorizationProvider('myapp', {
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
    const permissions = createPromptPermission('myapp', scope);

    // When
    const first = permissions.devicePermission(PRODUCT, 'Notifications');
    const second = permissions.devicePermission(PRODUCT, 'Notifications');
    await overlaysReady();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[data-testid="signing-modal-backdrop"]')).toHaveLength(1);
    });

    // When
    byTestId('signing-btn-secondary').click();

    // Then: the duplicate reads the saved grant instead of prompting, and
    // answers without upgrading what it found.
    await expect(Promise.all([first, second])).resolves.toEqual(['AllowAlways', 'AllowOnce']);
    await overlaysReady();
    expect(document.querySelector('[data-testid="signing-modal-backdrop"]')).toBeNull();
    expect(status).toBe('Authorized');
    scope.dispose();
    unregister();
  });

  it('As a dotli integrator, the host removes a disposed host modal and advances to the next host', async () => {
    // Given
    const coordinator = createBlockingModalCoordinator();
    const firstScope = coordinator.createScope();
    const secondScope = coordinator.createScope();
    const first = createUserConfirmationAdapters('first', firstScope).confirmUserAction({
      tag: 'IdentityDisclosure',
      value: { productId: 'first.dot' },
    });
    const second = createUserConfirmationAdapters('second', secondScope).confirmUserAction({
      tag: 'IdentityDisclosure',
      value: { productId: 'second.dot' },
    });
    await overlaysReady();

    // Then
    expect(byTestId('signing-field-value').textContent).toBe('first.dot');

    // When
    firstScope.dispose();

    // Then
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await overlaysReady();
    expect(document.querySelectorAll('[data-testid="signing-modal-backdrop"]')).toHaveLength(1);
    expect(byTestId('signing-field-value').textContent).toBe('second.dot');

    // When
    byTestId('signing-btn-sign').click();

    // Then
    await expect(second).resolves.toBe(true);
    secondScope.dispose();
  });

  it('As a dotli integrator, the host advances after a modal task throws', async () => {
    // Given
    const coordinator = createBlockingModalCoordinator();
    const firstScope = coordinator.createScope();
    const secondScope = coordinator.createScope();
    const failed = firstScope.enqueue(() => {
      throw new Error('render failed');
    });
    const completed = secondScope.enqueue(() => 'next');

    // Then
    await expect(failed).rejects.toThrow('render failed');
    await expect(completed).resolves.toBe('next');
    firstScope.dispose();
    secondScope.dispose();
  });

  it('As a dotli integrator, the host observes a rejecting task that disposes its own scope', async () => {
    // Given
    const scope = createBlockingModalCoordinator().createScope();
    const queued = scope.enqueue(() => {
      scope.dispose();
      return Promise.reject(new Error('late task failure'));
    });

    // Then
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
  });

  it('As a dotli integrator, the host rejects queued and future work when its host is disposed', async () => {
    // Given
    const coordinator = createBlockingModalCoordinator();
    const activeScope = coordinator.createScope();
    const disposedScope = coordinator.createScope();
    const { promise: held, resolve: finishActive }: PromiseWithResolvers<void> = Promise.withResolvers();
    const active = activeScope.enqueue(() => held);
    const queued = disposedScope.enqueue(() => 'queued');

    // When
    disposedScope.dispose();

    // Then
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await expect(disposedScope.enqueue(() => 'late')).rejects.toMatchObject({
      name: 'AbortError',
    });
    finishActive();
    await active;
    activeScope.dispose();
  });
});
