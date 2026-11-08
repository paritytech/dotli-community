// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's side of HostPrompts for specs: each ask waits in a queue until the spec answers it as the user would, and
// notices are recorded. A review is the page's own dialog in the modal store, so it hands off as the page does.

import { toAbortError } from '@dotli/shared';
import type { EnforceablePermissionName } from './permissionPolicy.js';
import { modals, type ModalView, type NotificationParams } from '@dotli/ui';
import type { HostPrompts, GrantAnswer } from './hostPrompts.js';

export type FakePrompt =
  | { kind: 'permission'; label: string; permission: EnforceablePermissionName; allowOnce: boolean }
  | { kind: 'review'; dialog: ModalView<string> };

type Pending = {
  /** The ask as it is now, or undefined once it is gone. A review reads its dialog from the store, which a handoff swaps. */
  prompt: () => FakePrompt | undefined;
  /** Answers the ask with `answer` and takes it off the queue. Never throws. */
  settle: (answer: string) => void;
};

type ShownPrompt = {
  entry: Pending;
  prompt: FakePrompt;
};

type WaitForPromptParams = {
  /** Which ask on screen to wait for, any by default. */
  matches?: (prompt: FakePrompt) => boolean;
};

export type FakePrompts = ReturnType<typeof createFakePrompts>;

/** The page's prompts for a spec, which the spec answers as the user would. Building it never throws. */
export function createFakePrompts() {
  const queue: Pending[] = [];
  const waiters = new Set<() => void>();
  const notices: NotificationParams[] = [];

  const prompts: HostPrompts = {
    askPermission: ({ label, permission, signal, allowOnce }) =>
      ask({ kind: 'permission', label, permission, allowOnce }, signal),
    async confirmReview({ dialog, signal, handoff }) {
      const opened = modals.open(dialog, { signal, handoff: outcome => handoff?.(outcome.result) });
      const id = modals.store.get().at(-1)?.id;
      if (id !== undefined && !signal.aborted) {
        queue.push({
          prompt() {
            const entry = modals.store.get().find(e => e.id === id);
            return entry === undefined ? undefined : { kind: 'review', dialog: entry.view };
          },
          settle(answer) {
            modals.settle(id, answer);
          },
        });
        wake();
      }
      return (await opened).result;
    },
    notify(notice) {
      notices.push(notice);
      wake();
    },
  };

  return {
    /** The prompts the runtime under test is given. */
    prompts,
    /** Every notice shown, in order. */
    notices,
    /** The asks still waiting for an answer, oldest first. */
    listPending: (): readonly FakePrompt[] => getLivePrompts().map(({ prompt }) => prompt),
    /** The ask on screen, which is the oldest one. Throws when no ask is on screen. */
    getShown: (): FakePrompt => getShownPrompt().prompt,
    /** The review dialog on screen. Throws when no review is on screen. */
    getShownReview,
    /**
     * Resolves with the ask on screen once one that `matches` is up, woken by each ask rather than polling. Never
     * rejects.
     */
    waitForPrompt,
    /** Resolves once no ask is on screen, woken by each change rather than polling. */
    waitForClearedScreen,
    /** Resolves with the notices once `count` have been shown, woken by each notice rather than polling. */
    waitForNotices,
    /** Answers the permission prompt on screen. Throws when no permission prompt is on screen. */
    decide,
    /**
     * Settles the review on screen with `result`, or closes the step a review handed off to with it. Throws when no
     * review is on screen.
     */
    settleReview,
    /** Presses the review button with this label. Throws when no review with that button is on screen. */
    chooseReviewButton,
    /**
     * A backdrop click or Escape: settles a review or permission prompt that allows it. Throws when no ask is on
     * screen.
     */
    dismiss,
  };

  // Every change of the queue, the modal store and the notices, so a waiter also sees a queued ask that became the one
  // on screen.
  function wake(): void {
    for (const check of [...waiters]) {
      check();
    }
  }

  function waitUntil<T>(ready: () => T | undefined): Promise<T> {
    return new Promise(resolve => {
      let unsubscribe = (): void => undefined;
      function check(): void {
        const value = ready();
        if (value !== undefined) {
          waiters.delete(check);
          unsubscribe();
          resolve(value);
        }
      }
      waiters.add(check);
      unsubscribe = modals.store.listen(check);
      check();
    });
  }

  /** The asks still up, oldest first, dropping those that are gone. */
  function getLivePrompts(): ShownPrompt[] {
    const up: ShownPrompt[] = [];
    for (const entry of [...queue]) {
      const prompt = entry.prompt();
      if (prompt === undefined) {
        queue.splice(queue.indexOf(entry), 1);
      } else {
        up.push({ entry, prompt });
      }
    }
    return up;
  }

  function ask<T>(prompt: FakePrompt, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      return Promise.reject(toAbortError(signal.reason, 'Prompt aborted'));
    }
    return new Promise<T>((resolve, reject) => {
      let gone = false;
      function take(): void {
        gone = true;
        signal.removeEventListener('abort', onAbort);
        wake();
      }
      function onAbort(): void {
        take();
        reject(toAbortError(signal.reason, 'Prompt aborted'));
      }
      queue.push({
        prompt: () => (gone ? undefined : prompt),
        settle(answer) {
          take();
          // The spec answers each ask with the value its prompt's kind resolves with.
          resolve(answer as T);
        },
      });
      signal.addEventListener('abort', onAbort, { once: true });
      wake();
    });
  }

  function getShownPrompt(): ShownPrompt {
    const shown = getLivePrompts()[0];
    if (shown === undefined) {
      throw new Error('expected a prompt on screen, none is');
    }
    return shown;
  }

  function getShownReview(): ModalView<string> {
    const { prompt } = getShownPrompt();
    if (prompt.kind !== 'review') {
      throw new Error(`expected a review on screen, a ${prompt.kind} prompt is`);
    }
    return prompt.dialog;
  }

  function waitForPrompt({ matches = () => true }: WaitForPromptParams = {}): Promise<FakePrompt> {
    return waitUntil(() => {
      const shown = getLivePrompts()[0];
      return shown !== undefined && matches(shown.prompt) ? shown.prompt : undefined;
    });
  }

  function waitForClearedScreen(): Promise<void> {
    return waitUntil(() => (getLivePrompts().length === 0 ? true : undefined)).then(() => undefined);
  }

  function waitForNotices(count: number): Promise<readonly NotificationParams[]> {
    return waitUntil(() => (notices.length >= count ? [...notices] : undefined));
  }

  function decide(decision: GrantAnswer): void {
    const { entry, prompt } = getShownPrompt();
    if (prompt.kind !== 'permission') {
      throw new Error(`expected a permission prompt on screen, a ${prompt.kind} prompt is`);
    }
    entry.settle(decision);
  }

  function settleReview(result: string): void {
    getShownReview();
    getShownPrompt().entry.settle(result);
  }

  function chooseReviewButton(label: string): void {
    const dialog = getShownReview();
    const button = dialog.buttons.find(b => b.label === label);
    if (button === undefined) {
      throw new Error(`expected a "${label}" button, the dialog has ${dialog.buttons.map(b => b.label).join(', ')}`);
    }
    getShownPrompt().entry.settle(button.result);
  }

  function dismiss(): void {
    const { entry, prompt } = getShownPrompt();
    switch (prompt.kind) {
      case 'permission':
        entry.settle('dismissed');
        return;
      case 'review':
        if (prompt.dialog.dismissOnBackdrop && prompt.dialog.dismissResult !== undefined) {
          entry.settle(prompt.dialog.dismissResult);
        }
        return;
    }
  }
}
