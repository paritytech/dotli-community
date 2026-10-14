// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { withActiveTld } from '@dotli/config';
import { chooseModalButton, dismissModal, shownModal } from '@dotli/ui/testing';
import { openModal } from '@dotli/ui';
import { SignIcon } from './components/icons/SignIcon.js';
import { createHostPrompts } from './page-prompts.js';

afterEach(() => {
  resetAllStoresForTests();
});

/** The prompts over the modal store, so a spec answers their dialogs in place of the overlays. */
const prompts = createHostPrompts({ present: openModal, notify: () => undefined });

const live = (): AbortSignal => new AbortController().signal;

describe('host prompts', () => {
  it('As a dotli user, a review shows the icon it carries and settles with the button I press', async () => {
    // Given
    const answer = prompts.confirmReview(
      {
        title: 'Sign Transaction',
        icon: SignIcon,
        fields: [],
        buttons: [
          { label: 'Cancel', variant: 'danger', result: 'rejected' },
          { label: 'Sign', variant: 'primary', result: 'accepted' },
        ],
        dismissOnBackdrop: true,
        dismissResult: 'dismissed',
      },
      live(),
    );

    // Then
    expect(shownModal().view.icon).toBe(SignIcon);

    // When
    chooseModalButton('Sign');

    // Then
    await expect(answer).resolves.toBe('accepted');
  });

  it('As a dotli user, a review with no glyph shows none', async () => {
    // Given
    const answer = prompts.confirmReview(
      {
        title: 'Resource Allocation',
        fields: [],
        buttons: [{ label: 'Allow', variant: 'primary', result: 'accepted' }],
        dismissOnBackdrop: false,
      },
      live(),
    );

    // Then
    expect(shownModal().view.icon).toBeUndefined();
    chooseModalButton('Allow');
    await expect(answer).resolves.toBe('accepted');
  });
});

describe('permission request', () => {
  it('As a dotli integrator, the host resolves granted when the user allows', async () => {
    // Given
    const decision = prompts.askPermission('myapp', 'Camera', live(), { allowOnce: false });

    // When
    chooseModalButton('Allow');

    // Then
    await expect(decision).resolves.toBe('granted');
  });

  it('As a dotli integrator, the host resolves denied when the user denies', async () => {
    // Given
    const decision = prompts.askPermission('myapp', 'Camera', live(), { allowOnce: false });

    // When
    chooseModalButton('Deny');

    // Then
    await expect(decision).resolves.toBe('denied');
  });

  it('As a dotli integrator, the host resolves dismissed when the backdrop is clicked', async () => {
    // Given
    const decision = prompts.askPermission('myapp', 'Camera', live(), { allowOnce: false });

    // When
    dismissModal();

    // Then
    await expect(decision).resolves.toBe('dismissed');
  });

  it('As a dotli user, choosing Allow once resolves a one-time grant', async () => {
    // Given
    const decision = prompts.askPermission('myapp', 'ChainSubmit', live(), { allowOnce: true });

    // When
    chooseModalButton('Allow once');

    // Then
    await expect(decision).resolves.toBe('granted-once');
  });

  it('As a dotli user, choosing Always allow resolves a lasting grant', async () => {
    // Given
    const decision = prompts.askPermission('myapp', 'ChainSubmit', live(), { allowOnce: true });

    // When
    chooseModalButton('Always allow');

    // Then
    await expect(decision).resolves.toBe('granted');
  });

  it('As a dotli user, the prompt names the app on the active network, and a device prompt says granting reloads it', () => {
    // When
    void prompts.askPermission('myapp', 'Camera', live(), { allowOnce: false });

    // Then
    const { view } = shownModal();
    expect(view.fields[0]).toEqual({ label: 'Application', value: withActiveTld('myapp') });
    expect(view.notice).toBe('Granting this permission will reload the application.');
  });

  it('As a dotli user, a prompt for an app permission says nothing of a reload', () => {
    // When
    void prompts.askPermission('myapp', 'ChainSubmit', live(), { allowOnce: true });

    // Then
    expect(shownModal().view.notice).toBeUndefined();
  });

  it('As a dotli integrator, aborting a queued dialog takes it down unanswered', async () => {
    // Given
    const controller = new AbortController();
    const decision = prompts.askPermission('myapp', 'Camera', controller.signal, { allowOnce: false });

    // When
    controller.abort();

    // Then
    await expect(decision).rejects.toMatchObject({ name: 'AbortError' });
    expect(() => shownModal()).toThrow();
  });
});

describe('preimage submit', () => {
  it('As a dotli user, I see the data size and can allow the submission', async () => {
    // Given
    const decision = prompts.confirmPreimage(2048, live());

    // Then
    expect(shownModal().view.title).toBe('Submit Preimage');

    // When
    chooseModalButton('Allow');

    // Then
    await expect(decision).resolves.toBe(true);
  });

  it('As a dotli user, cancelling refuses the submission, and the backdrop does nothing', async () => {
    // Given
    const decision = prompts.confirmPreimage(512, live());

    // When
    dismissModal();

    // Then
    expect(shownModal().view.title).toBe('Submit Preimage');

    // When
    chooseModalButton('Cancel');

    // Then
    await expect(decision).resolves.toBe(false);
  });

  it('As a dotli integrator, an abort rejects with AbortError and closes the dialog', async () => {
    // Given
    const controller = new AbortController();
    const decision = prompts.confirmPreimage(10, controller.signal);

    // When
    controller.abort();

    // Then
    await expect(decision).rejects.toMatchObject({ name: 'AbortError' });
    expect(() => shownModal()).toThrow();
  });
});
