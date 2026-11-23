// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's side of HostPrompts for specs: each ask is a dialog in the page's modal store, which the spec answers as
// the user would, and notices are recorded. A spec that uses it resets the stores after each case, as the store
// outlives the fake.

import type { EnforceablePermissionName } from '../policy/permissionPolicy.js';
import { modals, type ModalEntry, type ModalView, type NotificationParams } from '@dotli/ui';
import { isGranted, isRetry, type BrowserBlockAnswer, type GrantAnswer, type HostPrompts } from './hostPrompts.js';

export type FakePrompt =
  | { kind: 'permission'; label: string; permission: EnforceablePermissionName }
  | { kind: 'hostAccess'; label: string; host: string }
  | { kind: 'browserBlock'; label: string; permission: EnforceablePermissionName; retried: boolean }
  | { kind: 'review'; dialog: ModalView<string> };

type WaitForPromptParams = {
  /** Which ask on screen to wait for, any by default. */
  matches?: (prompt: FakePrompt) => boolean;
};

export type FakePrompts = ReturnType<typeof createFakePrompts>;

/** The page's prompts for a spec, which the spec answers as the user would. */
export function createFakePrompts() {
  // The ask each stand-in dialog shows. Any other dialog is a review, the view a review handed off to included.
  const asks = new WeakMap<ModalView<string>, FakePrompt>();
  const waiters = new Set<() => void>();
  const notices: NotificationParams[] = [];

  const prompts: HostPrompts = {
    askPermission: ({ label, permission, signal, onApprove }) =>
      ask(present<GrantAnswer>({ kind: 'permission', label, permission }, 'dismissed'), signal, answer => {
        if (isGranted(answer)) {
          onApprove();
        }
      }),
    askHostAccess: ({ label, host, signal }) =>
      ask(present<GrantAnswer>({ kind: 'hostAccess', label, host }, 'dismissed'), signal, () => undefined),
    askBrowserBlock: ({ label, permission, signal, retried, onRetry }) =>
      ask(
        present<BrowserBlockAnswer>({ kind: 'browserBlock', label, permission, retried }, 'dismissed'),
        signal,
        answer => {
          if (isRetry(answer)) {
            onRetry();
          }
        },
      ),
    confirmReview: async ({ dialog, signal, handoff }) =>
      (await modals.open(dialog, { signal, handoff: outcome => handoff?.(outcome.result) })).result,
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
    listPending: (): readonly FakePrompt[] => modals.store.get().map(toPrompt),
    /** The ask on screen, which is the oldest one. Throws when no ask is on screen. */
    getShown: (): FakePrompt => toPrompt(getShownEntry()),
    /** The review dialog on screen. Throws when no review is on screen. */
    getShownReview,
    /** Resolves with the ask on screen once one that `matches` is up, woken by each ask rather than polling. */
    waitForPrompt,
    /** Resolves once no ask is on screen, woken by each change rather than polling. */
    waitForClearedScreen,
    /** Resolves with the notices once `count` have been shown, woken by each notice rather than polling. */
    waitForNotices,
    /**
     * Answers the permission prompt on screen, running its approve hook first when `decision` grants it. Throws when no
     * permission prompt is on screen.
     */
    decide,
    /** Answers the host access prompt on screen. Throws when no host access prompt is on screen. */
    decideHostAccess,
    /**
     * Answers the browser block on screen, running its retry hook first on `retry`. Throws when no browser block is on
     * screen.
     */
    answerBrowserBlock,
    /**
     * Settles the review on screen with `result`, or closes the step a review handed off to with it. Throws when no
     * review is on screen.
     */
    settleReview,
    /** Presses the review button with this label. Throws when no review with that button is on screen. */
    chooseReviewButton,
    /**
     * A backdrop click or Escape: settles a review, permission prompt or browser block that allows it. Throws when no
     * ask is on screen.
     */
    dismiss,
  };

  /** A stand-in dialog for `prompt`, which a backdrop click answers with `dismissResult`. */
  function present<Answer extends string>(prompt: FakePrompt, dismissResult: Answer): ModalView<Answer> {
    const view: ModalView<Answer> = {
      title: prompt.kind,
      fields: [],
      buttons: [],
      dismissOnBackdrop: true,
      dismissResult,
    };
    asks.set(view, prompt);
    return view;
  }

  /** Queues `view` and resolves with its answer. `heard` sees the answer in the handoff, as a click's handoff does. */
  async function ask<Answer extends string>(
    view: ModalView<Answer>,
    signal: AbortSignal,
    heard: (answer: Answer) => void,
  ): Promise<Answer> {
    const { result } = await modals.open(view, {
      signal,
      handoff: outcome => {
        heard(outcome.result);
        return undefined;
      },
    });
    return result;
  }

  function toPrompt(entry: ModalEntry): FakePrompt {
    return asks.get(entry.view) ?? { kind: 'review', dialog: entry.view };
  }

  function wake(): void {
    for (const check of [...waiters]) {
      check();
    }
  }

  // Woken by each change of the modal store and each notice.
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

  function getShownEntry(): ModalEntry {
    const shown = modals.store.get()[0];
    if (shown === undefined) {
      throw new Error('expected a prompt on screen, none is');
    }
    return shown;
  }

  function getShownOf(kind: FakePrompt['kind']): ModalEntry {
    const shown = getShownEntry();
    const prompt = toPrompt(shown);
    if (prompt.kind !== kind) {
      throw new Error(`expected a ${kind} prompt on screen, a ${prompt.kind} prompt is`);
    }
    return shown;
  }

  function getShownReview(): ModalView<string> {
    return getShownOf('review').view;
  }

  function waitForPrompt({ matches = () => true }: WaitForPromptParams = {}): Promise<FakePrompt> {
    return waitUntil(() => {
      const shown = modals.store.get()[0];
      if (shown === undefined) {
        return undefined;
      }
      const prompt = toPrompt(shown);
      return matches(prompt) ? prompt : undefined;
    });
  }

  function waitForClearedScreen(): Promise<void> {
    return waitUntil(() => (modals.store.get().length === 0 ? true : undefined)).then(() => undefined);
  }

  function waitForNotices(count: number): Promise<readonly NotificationParams[]> {
    return waitUntil(() => (notices.length >= count ? [...notices] : undefined));
  }

  function decide(decision: GrantAnswer): void {
    modals.settle(getShownOf('permission').id, decision);
  }

  function decideHostAccess(decision: GrantAnswer): void {
    modals.settle(getShownOf('hostAccess').id, decision);
  }

  function answerBrowserBlock(answer: BrowserBlockAnswer): void {
    modals.settle(getShownOf('browserBlock').id, answer);
  }

  function settleReview(result: string): void {
    modals.settle(getShownOf('review').id, result);
  }

  function chooseReviewButton(label: string): void {
    const { id, view } = getShownOf('review');
    const button = view.buttons.find(b => b.label === label);
    if (button === undefined) {
      throw new Error(`expected a "${label}" button, the dialog has ${view.buttons.map(b => b.label).join(', ')}`);
    }
    modals.settle(id, button.result);
  }

  function dismiss(): void {
    const { id, view } = getShownEntry();
    if (view.dismissOnBackdrop && view.dismissResult !== undefined) {
      modals.settle(id, view.dismissResult);
    }
  }
}
