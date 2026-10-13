// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's side of HostPrompts for specs: each ask waits in a queue until the spec answers it as the user would, and
// notices are recorded.

import { toAbortError } from '@dotli/shared';
import type { EnforceablePermissionName } from './permissions.js';
import type { ModalView, NotificationParams } from '@dotli/ui';
import type { HostPrompts, PermissionPromptDecision } from './host-prompts.js';

export type FakePrompt =
  | { kind: 'permission'; label: string; permission: EnforceablePermissionName; allowOnce: boolean }
  | { kind: 'preimage'; size: number }
  | { kind: 'review'; dialog: ModalView<string> };

interface Pending {
  prompt: FakePrompt;
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
  /** Answers the permission prompt on screen. */
  decide: (decision: PermissionPromptDecision) => void;
  /** Answers the preimage prompt on screen. */
  allowPreimage: (allowed: boolean) => void;
  /** Settles the review on screen with `result`. */
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
  // Every change of the queue, so a waiter also sees a queued ask that became the one on screen.
  const wake = (): void => {
    for (const check of [...waiters]) {
      check();
    }
  };

  const ask = <T>(prompt: FakePrompt, signal: AbortSignal): Promise<T> => {
    if (signal.aborted) {
      return Promise.reject(toAbortError(signal.reason, 'Prompt aborted'));
    }
    return new Promise<T>((resolve, reject) => {
      function take(): boolean {
        const index = queue.indexOf(entry);
        if (index === -1) {
          return false;
        }
        queue.splice(index, 1);
        signal.removeEventListener('abort', onAbort);
        wake();
        return true;
      }
      function onAbort(): void {
        if (take()) {
          reject(toAbortError(signal.reason, 'Prompt aborted'));
        }
      }
      const entry: Pending = {
        prompt,
        settle: answer => {
          take();
          resolve(answer as T);
        },
      };
      signal.addEventListener('abort', onAbort, { once: true });
      queue.push(entry);
      wake();
    });
  };

  const top = (): Pending => {
    const entry = queue[0];
    if (entry === undefined) {
      throw new Error('expected a prompt on screen, none is');
    }
    return entry;
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
      confirmPreimage: (size, signal) => ask({ kind: 'preimage', size }, signal),
      confirmReview: (dialog, signal) => ask({ kind: 'review', dialog }, signal),
      notify: notice => {
        notices.push(notice);
      },
    },
    notices,
    pending: () => queue.map(entry => entry.prompt),
    shown: () => top().prompt,
    shownReview,
    promptShown: (matches = () => true) =>
      new Promise(resolve => {
        const check = (): void => {
          const entry = queue[0];
          if (entry !== undefined && matches(entry.prompt)) {
            waiters.delete(check);
            resolve(entry.prompt);
          }
        };
        waiters.add(check);
        check();
      }),
    decide: decision => {
      const entry = top();
      if (entry.prompt.kind !== 'permission') {
        throw new Error(`expected a permission prompt on screen, a ${entry.prompt.kind} prompt is`);
      }
      entry.settle(decision);
    },
    allowPreimage: allowed => {
      const entry = top();
      if (entry.prompt.kind !== 'preimage') {
        throw new Error(`expected a preimage prompt on screen, a ${entry.prompt.kind} prompt is`);
      }
      entry.settle(allowed);
    },
    settleReview: result => {
      shownReview();
      top().settle(result);
    },
    chooseReviewButton: label => {
      const dialog = shownReview();
      const button = dialog.buttons.find(b => b.label === label);
      if (button === undefined) {
        throw new Error(`expected a "${label}" button, the dialog has ${dialog.buttons.map(b => b.label).join(', ')}`);
      }
      top().settle(button.result);
    },
    dismiss: () => {
      const entry = top();
      if (entry.prompt.kind === 'permission') {
        entry.settle('dismissed');
      } else if (
        entry.prompt.kind === 'review' &&
        entry.prompt.dialog.dismissOnBackdrop &&
        entry.prompt.dialog.dismissResult !== undefined
      ) {
        entry.settle(entry.prompt.dialog.dismissResult);
      }
    },
  };
}
