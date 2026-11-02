// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { withActiveTld } from '@dotli/config';
import { chooseModalButton, dismissModal, shownModal } from '@dotli/ui/testing';
import { modals } from '@dotli/ui';
import { SignIcon } from './components/icons/SignIcon.js';
import { createHostPrompts } from './createHostPrompts.js';
import type { PermissionPromptDecision } from './runtime/hostPrompts.js';
import type { EnforceablePermissionName } from './runtime/permissionPolicy.js';

afterEach(() => {
  resetAllStoresForTests();
});

/** The prompts over the modal store, so a spec answers their dialogs in place of the overlays. */
const prompts = createHostPrompts({ present: modals.open, notify: () => undefined });

describe('host prompts', () => {
  it('As a dotli user, I sign a review that carries an icon and see the icon while the review settles with my choice', async () => {
    // When
    const answer = prompts.confirmReview({
      dialog: {
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
      signal: createLiveSignal(),
    });
    const shownIcon = shownModal().view.icon;
    chooseModalButton('Sign');

    // Then
    expect(shownIcon).toBe(SignIcon);
    await expect(answer).resolves.toBe('accepted');
  });

  it('As a dotli user, I approve a review and its dialog hands its place to the next step', async () => {
    // Given
    const heard: string[] = [];
    const closed: string[] = [];
    const answer = prompts.confirmReview({
      dialog: {
        title: 'Sign Transaction',
        fields: [],
        buttons: [
          { label: 'Cancel', variant: 'danger', result: 'rejected' },
          { label: 'Sign', variant: 'primary', result: 'accepted' },
        ],
        dismissOnBackdrop: false,
      },
      signal: createLiveSignal(),
      handoff(result) {
        heard.push(result);
        return {
          view: {
            title: 'Waiting',
            fields: [],
            buttons: [{ label: 'Wait in background', variant: 'secondary', result: 'background' }],
            dismissOnBackdrop: false,
          },
          signal: createLiveSignal(),
          closed: how => closed.push(how),
        };
      },
    });

    // When
    chooseModalButton('Sign');
    const handedTo = shownModal().view.title;
    chooseModalButton('Wait in background');

    // Then
    await expect(answer).resolves.toBe('accepted');
    expect(heard).toEqual(['accepted']);
    expect(handedTo).toBe('Waiting');
    expect(closed).toEqual(['background']);
    expect(() => shownModal()).toThrow();
  });

  it('As a dotli user, I allow a review with no glyph and see no icon on it', async () => {
    // When
    const answer = prompts.confirmReview({
      dialog: {
        title: 'Resource Allocation',
        fields: [],
        buttons: [{ label: 'Allow', variant: 'primary', result: 'accepted' }],
        dismissOnBackdrop: false,
      },
      signal: createLiveSignal(),
    });
    const shownIcon = shownModal().view.icon;
    chooseModalButton('Allow');

    // Then
    expect(shownIcon).toBeUndefined();
    await expect(answer).resolves.toBe('accepted');
  });
});

describe('permission request', () => {
  it.each<{
    story: string;
    permission: EnforceablePermissionName;
    allowOnce: boolean;
    answer: () => void;
    expected: PermissionPromptDecision;
  }>([
    {
      story: 'Allow',
      permission: 'Camera',
      allowOnce: false,
      answer: pressButton('Allow'),
      expected: 'granted',
    },
    {
      story: 'Deny',
      permission: 'Camera',
      allowOnce: false,
      answer: pressButton('Deny'),
      expected: 'denied',
    },
    { story: 'a backdrop click', permission: 'Camera', allowOnce: false, answer: dismissModal, expected: 'dismissed' },
    {
      story: 'Allow once',
      permission: 'ChainSubmit',
      allowOnce: true,
      answer: pressButton('Allow once'),
      expected: 'granted-once',
    },
    {
      story: 'Always allow',
      permission: 'ChainSubmit',
      allowOnce: true,
      answer: pressButton('Always allow'),
      expected: 'granted',
    },
  ])(
    'As a dotli user, I answer a permission prompt with $story and the app gets $expected',
    async ({ permission, allowOnce, answer, expected }) => {
      // Given
      const decision = prompts.askPermission({ label: 'myapp', permission, signal: createLiveSignal(), allowOnce });

      // When
      answer();

      // Then
      await expect(decision).resolves.toBe(expected);
    },
  );

  it('As a dotli user, I get a device permission prompt and it names the app on the active network and says granting reloads it', () => {
    // When
    void prompts.askPermission({ label: 'myapp', permission: 'Camera', signal: createLiveSignal(), allowOnce: false });
    const { view } = shownModal();

    // Then
    expect(view.fields[0]).toEqual({ label: 'Application', value: withActiveTld('myapp') });
    expect(view.notice).toBe('Granting this permission will reload the application.');
  });

  it('As a dotli user, I get a prompt for an app permission and it says nothing of a reload', () => {
    // When
    void prompts.askPermission({
      label: 'myapp',
      permission: 'ChainSubmit',
      signal: createLiveSignal(),
      allowOnce: true,
    });

    // Then
    expect(shownModal().view.notice).toBeUndefined();
  });

  it('As a dotli integrator, I abort a queued dialog and it goes down unanswered', async () => {
    // Given
    const controller = new AbortController();
    const decision = prompts.askPermission({
      label: 'myapp',
      permission: 'Camera',
      signal: controller.signal,
      allowOnce: false,
    });

    // When
    controller.abort();

    // Then
    await expect(decision).rejects.toMatchObject({ name: 'AbortError' });
    expect(() => shownModal()).toThrow();
  });
});

describe('preimage submit', () => {
  it('As a dotli user, I see the preimage dialog for my app and allow it and the submission goes ahead', async () => {
    // When
    const decision = prompts.confirmPreimage({ label: 'myapp', size: 2048, signal: createLiveSignal() });
    const { view } = shownModal();
    chooseModalButton('Allow');

    // Then
    expect(view.title).toBe('Submit Preimage');
    expect(view.fields[0]).toEqual({ label: 'Application', value: withActiveTld('myapp') });
    await expect(decision).resolves.toBe(true);
  });

  it('As a dotli user, I click the backdrop and then Cancel and only Cancel refuses the submission', async () => {
    // Given
    const decision = prompts.confirmPreimage({ label: 'myapp', size: 512, signal: createLiveSignal() });

    // When
    dismissModal();
    const titleAfterBackdrop = shownModal().view.title;
    chooseModalButton('Cancel');

    // Then
    expect(titleAfterBackdrop).toBe('Submit Preimage');
    await expect(decision).resolves.toBe(false);
  });

  it('As a dotli integrator, I abort a preimage dialog and it rejects with AbortError and closes', async () => {
    // Given
    const controller = new AbortController();
    const decision = prompts.confirmPreimage({ label: 'myapp', size: 10, signal: controller.signal });

    // When
    controller.abort();

    // Then
    await expect(decision).rejects.toMatchObject({ name: 'AbortError' });
    expect(() => shownModal()).toThrow();
  });

  it("As a dotli developer, I open any host prompt and it carries the host's own test id", () => {
    // When
    void prompts.askPermission({ label: 'myapp', permission: 'Camera', signal: createLiveSignal(), allowOnce: false });

    // Then
    expect(shownModal().view.testId).toBe('host-prompt');
  });
});

/** Returns a signal that never aborts. */
function createLiveSignal(): AbortSignal {
  return new AbortController().signal;
}

/** Returns an answer that presses the shown dialog's button `label`. */
function pressButton(label: string): () => void {
  return () => {
    chooseModalButton(label);
  };
}
