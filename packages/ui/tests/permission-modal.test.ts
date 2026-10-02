import { afterEach, describe, expect, it } from 'vitest';
import { showPermissionRequestModal } from '../src/permission-modal.js';
import { overlaysReady, resetOverlays } from './helpers/overlays.js';

afterEach(() => {
  resetOverlays();
  document.body.replaceChildren();
});

describe('permission request modal', () => {
  it('As a dotli integrator, the host resolves granted when the user allows', async () => {
    // Given
    const decision = showPermissionRequestModal('myapp', 'Camera');
    await overlaysReady();

    // When
    document.querySelector<HTMLButtonElement>('[data-testid="signing-btn-sign"]')?.click();

    // Then
    await expect(decision).resolves.toBe('granted');
  });

  it('As a dotli integrator, the host resolves denied when the user denies', async () => {
    // Given
    const decision = showPermissionRequestModal('myapp', 'Camera');
    await overlaysReady();

    // When
    document.querySelector<HTMLButtonElement>('[data-testid="signing-btn-cancel"]')?.click();

    // Then
    await expect(decision).resolves.toBe('denied');
  });

  it('As a dotli integrator, the host resolves dismissed when the backdrop is clicked', async () => {
    // Given
    const decision = showPermissionRequestModal('myapp', 'Camera');
    await overlaysReady();

    // When
    document.querySelector<HTMLDivElement>('[data-testid="signing-modal-backdrop"]')?.click();

    // Then
    await expect(decision).resolves.toBe('dismissed');
  });

  it('As a dotli user, a two-way prompt offers Deny and Allow', async () => {
    // When
    void showPermissionRequestModal('myapp', 'Camera');
    await overlaysReady();

    // Then
    expect(footerButtons()).toEqual([
      { text: 'Deny', testId: 'signing-btn-cancel' },
      { text: 'Allow', testId: 'signing-btn-sign' },
    ]);
  });

  it('As a dotli user, a three-way prompt highlights Allow once', async () => {
    // When
    void showPermissionRequestModal('myapp', 'ChainSubmit', undefined, {
      allowOnce: true,
    });
    await overlaysReady();

    // Then
    expect(footerButtons()).toEqual([
      { text: 'Deny', testId: 'signing-btn-cancel' },
      { text: 'Always allow', testId: 'signing-btn-secondary' },
      { text: 'Allow once', testId: 'signing-btn-sign' },
    ]);
  });

  it('As a dotli user, choosing Allow once resolves a one-time grant', async () => {
    // Given
    const decision = showPermissionRequestModal('myapp', 'ChainSubmit', undefined, { allowOnce: true });
    await overlaysReady();

    // When
    document.querySelector<HTMLButtonElement>('[data-testid="signing-btn-sign"]')?.click();

    // Then
    await expect(decision).resolves.toBe('granted-once');
  });

  it('As a dotli user, choosing Always allow resolves a lasting grant', async () => {
    // Given
    const decision = showPermissionRequestModal('myapp', 'ChainSubmit', undefined, { allowOnce: true });
    await overlaysReady();

    // When
    document.querySelector<HTMLButtonElement>('[data-testid="signing-btn-secondary"]')?.click();

    // Then
    await expect(decision).resolves.toBe('granted');
  });

  it('As a dotli integrator, aborting while the dialog is still loading never shows it', async () => {
    // Given
    const controller = new AbortController();
    const decision = showPermissionRequestModal('myapp', 'Camera', controller.signal);

    // When
    controller.abort();
    await overlaysReady();

    // Then
    await expect(decision).rejects.toMatchObject({ name: 'AbortError' });
    expect(document.querySelector('[data-testid="signing-modal-backdrop"]')).toBeNull();
  });
});

function footerButtons(): { text: string; testId: string | null }[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-testid="signing-modal-footer"] button'),
    button => ({
      text: button.textContent,
      testId: button.getAttribute('data-testid'),
    }),
  );
}
