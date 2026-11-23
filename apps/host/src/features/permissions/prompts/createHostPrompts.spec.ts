// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { withActiveTld } from '@dotli/config';
import { chooseModalButton, dismissModal, shownModal } from '@dotli/ui/testing';
import { modals } from '@dotli/ui';
import { createHostPrompts } from './createHostPrompts.js';
import type { BrowserBlockAnswer, GrantAnswer } from './hostPrompts.js';

afterEach(() => {
  resetAllStoresForTests();
});

/** The prompts over the modal store, so a spec answers their dialogs in place of the overlays. */
const prompts = createHostPrompts({ present: modals.open, notify: () => undefined });

describe('host prompts', () => {
  it('As a dotli user, I approve a review, its handoff hears my answer and the caller gets it', async () => {
    // Given
    const heard: string[] = [];
    const answer = prompts.confirmReview({
      dialog: {
        title: 'Sign transaction',
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
        return undefined;
      },
    });

    // When
    chooseModalButton('Sign');

    // Then
    await expect(answer).resolves.toBe('accepted');
    expect(heard).toEqual(['accepted']);
  });

  it.each<{ story: string; open: () => void }>([
    {
      story: 'a permission prompt',
      open: () =>
        void prompts.askPermission({
          label: 'myapp',
          permission: 'Notifications',
          signal: createLiveSignal(),
          onApprove: () => undefined,
        }),
    },
    {
      story: 'a fetch prompt',
      open: () => void prompts.askHostAccess({ label: 'myapp', host: 'api.example.com', signal: createLiveSignal() }),
    },
    {
      story: 'a browser block',
      open: () =>
        void prompts.askBrowserBlock({
          label: 'myapp',
          permission: 'Notifications',
          signal: createLiveSignal(),
          retried: false,
          onRetry: () => undefined,
        }),
    },
  ])('As a dotli user, I see $story that names the app on the active network', ({ open }) => {
    // When
    open();

    // Then
    expect(shownModal().view.fields.map(field => field.value)).toContain(withActiveTld('myapp'));
  });
});

describe('permission request', () => {
  it.each<{ story: string; answer: () => void; expected: GrantAnswer; approvals: number }>([
    { story: 'Always allow', answer: pressButton('Always allow'), expected: 'granted', approvals: 1 },
    { story: 'a backdrop click', answer: dismissModal, expected: 'dismissed', approvals: 0 },
  ])(
    'As a dotli user, I answer a permission prompt with $story, the approve hook runs $approvals times inside my click and the app gets $expected',
    async ({ answer, expected, approvals }) => {
      // Given
      const onApprove = vi.fn();
      const decision = prompts.askPermission({
        label: 'myapp',
        permission: 'Notifications',
        signal: createLiveSignal(),
        onApprove,
      });

      // When
      answer();

      // Then
      expect(onApprove).toHaveBeenCalledTimes(approvals);
      await expect(decision).resolves.toBe(expected);
    },
  );

  it('As a dotli integrator, I abort a permission ask and it rejects with an AbortError', async () => {
    // Given
    const controller = new AbortController();
    const decision = prompts.askPermission({
      label: 'myapp',
      permission: 'Notifications',
      signal: controller.signal,
      onApprove: () => undefined,
    });

    // When
    controller.abort();

    // Then
    await expect(decision).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('browser block', () => {
  it.each<{ story: string; answer: () => void; expected: BrowserBlockAnswer; retries: number }>([
    { story: 'Retry', answer: pressButton('Retry'), expected: 'retry', retries: 1 },
    { story: 'a backdrop click', answer: dismissModal, expected: 'dismissed', retries: 0 },
  ])(
    'As a dotli user, I answer a browser block with $story, the retry hook runs $retries times inside my click and the runtime gets $expected',
    async ({ answer, expected, retries }) => {
      // Given
      const onRetry = vi.fn();
      const decision = prompts.askBrowserBlock({
        label: 'myapp',
        permission: 'Notifications',
        signal: createLiveSignal(),
        retried: false,
        onRetry,
      });

      // When
      answer();

      // Then
      expect(onRetry).toHaveBeenCalledTimes(retries);
      await expect(decision).resolves.toBe(expected);
    },
  );
});

describe('host prompt test id', () => {
  it("As a dotli developer, I open any host prompt and it carries the host's own test id", () => {
    // When
    void prompts.askPermission({
      label: 'myapp',
      permission: 'Notifications',
      signal: createLiveSignal(),
      onApprove: () => undefined,
    });

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
