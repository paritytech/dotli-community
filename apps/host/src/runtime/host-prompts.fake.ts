// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's side of HostPrompts for specs: each ask waits in a queue until the spec answers it as the user would, and
// notices are recorded. A review is the page's own dialog in the modal store, so it hands off as the page does.

import { toAbortError } from '@dotli/shared';
import type { EnforceablePermissionName } from './permissions.js';
import { openModal, type ModalView, type NotificationParams } from '@dotli/ui';
import { modalsStore, settleModal } from '@dotli/ui/testing';
import type { HostPrompts, PermissionPromptDecision } from './host-prompts.js';

export type FakePrompt =
  | { kind: 'permission'; label: string; permission: EnforceablePermissionName; allowOnce: boolean }
  | { kind: 'preimage'; label: string; size: number }
  | { kind: 'review'; dialog: ModalView<string> };

interface Pending {
  /** The ask as it is now, or undefined once it is gone. A review reads its dialog from the store, which a handoff swaps. */
  prompt: () => FakePrompt | undefined;
  settle: (answer: string | boolean) => void;
}

export interface FakePrompts {
  prompts: HostPrompts;
  /** Every notice shown, in order. */
  notices: NotificationParams[];
  /** The asks still waiting for an answer, oldest first. */
  pending: () => readonly FakePrompt[];
  /** The ask on screen, which is the oldest one. */
  shown: () => FakePrompt;
  /** The review dialog on screen. */
  shownReview: () => ModalView<string>;
  /** Resolves with the ask on screen once one that `matches` is up, woken by each ask rather than polling. */
  promptShown: (matches?: (prompt: FakePrompt) => boolean) => Promise<FakePrompt>;
  /** Resolves once no ask is on screen, woken by each change rather than polling. */
  screenCleared: () => Promise<void>;
  /** Resolves with the notices once `count` have been shown, woken by each notice rather than polling. */
  noticesShown: (count: number) => Promise<readonly NotificationParams[]>;
  /** Answers the permission prompt on screen. */
  decide: (decision: PermissionPromptDecision) => void;
  /** Answers the preimage prompt on screen. */
  allowPreimage: (allowed: boolean) => void;
  /** Settles the review on screen with `result`, or closes the step a review handed off to with it. */
  settleReview: (result: string) => void;
  /** Presses the review button with this label. */
  chooseReviewButton: (label: string) => void;
  /** A backdrop click or Escape: settles a review or permission prompt that allows it, and leaves a preimage one up. */
  dismiss: () => void;
}

export function createFakePrompts(): FakePrompts {
  const queue: Pending[] = [];
  const waiters = new Set<() => void>();
  const notices: NotificationParams[] = [];
  // Every change of the queue, the modal store and the notices, so a waiter also sees a queued ask that became the one
  // on screen.
  const wake = (): void => {
    for (const check of [...waiters]) {
      check();
    }
  };
  const until = <T>(ready: () => T | undefined): Promise<T> =>
    new Promise(resolve => {
      let unsubscribe = (): void => undefined;
      const check = (): void => {
        const value = ready();
        if (value !== undefined) {
          waiters.delete(check);
          unsubscribe();
          resolve(value);
        }
      };
      waiters.add(check);
      unsubscribe = modalsStore.subscribe(check);
      check();
    });

  /** The asks still up, oldest first, dropping those that are gone. */
  const live = (): { entry: Pending; prompt: FakePrompt }[] => {
    const up: { entry: Pending; prompt: FakePrompt }[] = [];
    for (const entry of [...queue]) {
      const prompt = entry.prompt();
      if (prompt === undefined) {
        queue.splice(queue.indexOf(entry), 1);
      } else {
        up.push({ entry, prompt });
      }
    }
    return up;
  };

  const ask = <T>(prompt: FakePrompt, signal: AbortSignal): Promise<T> => {
    if (signal.aborted) {
      return Promise.reject(toAbortError(signal.reason, 'Prompt aborted'));
    }
    return new Promise<T>((resolve, reject) => {
      let gone = false;
      const take = (): void => {
        gone = true;
        signal.removeEventListener('abort', onAbort);
        wake();
      };
      function onAbort(): void {
        take();
        reject(toAbortError(signal.reason, 'Prompt aborted'));
      }
      queue.push({
        prompt: () => (gone ? undefined : prompt),
        settle: answer => {
          take();
          resolve(answer as T);
        },
      });
      signal.addEventListener('abort', onAbort, { once: true });
      wake();
    });
  };

  const top = (): { entry: Pending; prompt: FakePrompt } => {
    const shown = live()[0];
    if (shown === undefined) {
      throw new Error('expected a prompt on screen, none is');
    }
    return shown;
  };

  const shownReview = (): ModalView<string> => {
    const { prompt } = top();
    if (prompt.kind !== 'review') {
      throw new Error(`expected a review on screen, a ${prompt.kind} prompt is`);
    }
    return prompt.dialog;
  };

  return {
    prompts: {
      askPermission: (label, permission, signal, { allowOnce }) =>
        ask({ kind: 'permission', label, permission, allowOnce }, signal),
      confirmPreimage: (label, size, signal) => ask({ kind: 'preimage', label, size }, signal),
      confirmReview: async (dialog, signal, handoff) => {
        const opened = openModal(dialog, signal, outcome => handoff?.(outcome.result));
        const id = modalsStore.get().at(-1)?.id;
        if (id !== undefined && !signal.aborted) {
          queue.push({
            prompt: () => {
              const entry = modalsStore.get().find(e => e.id === id);
              return entry === undefined ? undefined : { kind: 'review', dialog: entry.view };
            },
            settle: answer => {
              settleModal(id, String(answer));
            },
          });
          wake();
        }
        return (await opened).result;
      },
      notify: notice => {
        notices.push(notice);
        wake();
      },
    },
    notices,
    pending: () => live().map(({ prompt }) => prompt),
    shown: () => top().prompt,
    shownReview,
    promptShown: (matches = () => true) =>
      until(() => {
        const shown = live()[0];
        return shown !== undefined && matches(shown.prompt) ? shown.prompt : undefined;
      }),
    screenCleared: () => until(() => (live().length === 0 ? true : undefined)).then(() => undefined),
    noticesShown: count => until(() => (notices.length >= count ? [...notices] : undefined)),
    decide: decision => {
      const { entry, prompt } = top();
      if (prompt.kind !== 'permission') {
        throw new Error(`expected a permission prompt on screen, a ${prompt.kind} prompt is`);
      }
      entry.settle(decision);
    },
    allowPreimage: allowed => {
      const { entry, prompt } = top();
      if (prompt.kind !== 'preimage') {
        throw new Error(`expected a preimage prompt on screen, a ${prompt.kind} prompt is`);
      }
      entry.settle(allowed);
    },
    settleReview: result => {
      shownReview();
      top().entry.settle(result);
    },
    chooseReviewButton: label => {
      const dialog = shownReview();
      const button = dialog.buttons.find(b => b.label === label);
      if (button === undefined) {
        throw new Error(`expected a "${label}" button, the dialog has ${dialog.buttons.map(b => b.label).join(', ')}`);
      }
      top().entry.settle(button.result);
    },
    dismiss: () => {
      const { entry, prompt } = top();
      if (prompt.kind === 'permission') {
        entry.settle('dismissed');
      } else if (
        prompt.kind === 'review' &&
        prompt.dialog.dismissOnBackdrop &&
        prompt.dialog.dismissResult !== undefined
      ) {
        entry.settle(prompt.dialog.dismissResult);
      }
    },
  };
}
