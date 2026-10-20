// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's side of HostPrompts for specs: each ask waits in a queue until the spec answers it as the user would, and
// notices are recorded.

import { captureException } from '@dotli/metrics';
import { toAbortError } from '@dotli/shared';
import type { EnforceablePermissionName } from './permissions.js';
import type { ModalHandoff, ModalView, NotificationParams } from '@dotli/ui';
import type { HostPrompts, PermissionPromptDecision } from './host-prompts.js';

export type FakePrompt =
  | { kind: 'permission'; label: string; permission: EnforceablePermissionName; allowOnce: boolean }
  | { kind: 'preimage'; label: string; size: number }
  | { kind: 'review'; dialog: ModalView<string> };

interface Pending {
  /** A handed-off review swaps its dialog in place. */
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
  // Every change of the queue and every notice, so a waiter also sees a queued ask that became the one on screen.
  const wake = (): void => {
    for (const check of [...waiters]) {
      check();
    }
  };
  const until = <T>(ready: () => T | undefined): Promise<T> =>
    new Promise(resolve => {
      const check = (): void => {
        const value = ready();
        if (value !== undefined) {
          waiters.delete(check);
          resolve(value);
        }
      };
      waiters.add(check);
      check();
    });

  const ask = <T>(
    prompt: FakePrompt,
    signal: AbortSignal,
    handoff?: (answer: string) => ModalHandoff | undefined,
  ): Promise<T> => {
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
      // As the page's dialogs do: the handoff sees every answer, and its step closes on its own signal only.
      function handOff(next: ModalHandoff): void {
        signal.removeEventListener('abort', onAbort);
        const onStepAbort = (): void => {
          if (take()) {
            next.closed('aborted');
          }
        };
        next.signal.addEventListener('abort', onStepAbort, { once: true });
        entry.prompt = { kind: 'review', dialog: next.view };
        entry.settle = answer => {
          next.signal.removeEventListener('abort', onStepAbort);
          take();
          next.closed(String(answer));
        };
        wake();
      }
      const entry: Pending = {
        prompt,
        settle: answer => {
          let next: ModalHandoff | undefined;
          try {
            next = handoff?.(String(answer));
          } catch (err) {
            // The answer still reaches the caller, and the dialog closes as without a handoff.
            captureException(err, { flow: 'ui', step: 'modal_handoff', tags: { kind: 'modal_handoff_error' } });
          }
          if (next !== undefined && !next.signal.aborted) {
            handOff(next);
          } else {
            take();
            next?.closed('aborted');
          }
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
      confirmPreimage: (label, size, signal) => ask({ kind: 'preimage', label, size }, signal),
      confirmReview: (dialog, signal, handoff) =>
        ask({ kind: 'review', dialog }, signal, handoff as ((answer: string) => ModalHandoff | undefined) | undefined),
      notify: notice => {
        notices.push(notice);
        wake();
      },
    },
    notices,
    pending: () => queue.map(entry => entry.prompt),
    shown: () => top().prompt,
    shownReview,
    promptShown: (matches = () => true) =>
      until(() => {
        const entry = queue[0];
        return entry !== undefined && matches(entry.prompt) ? entry.prompt : undefined;
      }),
    screenCleared: () => until(() => (queue.length === 0 ? true : undefined)).then(() => undefined),
    noticesShown: count => until(() => (notices.length >= count ? [...notices] : undefined)),
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
