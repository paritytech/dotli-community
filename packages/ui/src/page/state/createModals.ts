// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The overlays render the first entry. Everything that decides how a dialog settles lives
// here, outside Solid.

import { createSharedRun, registerStoreStateReset, toAbortError, registerAtomReset } from '@dotli/shared';
import { createReporter, defineCount } from '@dotli/metrics';
import { atom, type ReadableAtom } from 'nanostores';
import type { Component } from 'solid-js';
import type { IconProps } from '../../components/icons/iconProps.js';

const report = createReporter({ flow: 'ui' });

/**
 * A view an answered dialog was to hand its place to that could not be built, so the dialog closed instead. Tagged
 * `outcome` (error) and `reason` (the error's name).
 */
const modalHandoffMetric = defineCount<'error'>('modal.handoff');

/**
 * `danger` rejects the request and is drawn destructive. `cancel` backs out of a prompt that is not a
 * request to reject. `secondary` is the lesser approval. `primary` is the main one, which Enter submits.
 */
export type ModalButtonVariant = 'cancel' | 'danger' | 'secondary' | 'primary';

export type ModalField = {
  label: string;
  value: string;
  mono?: boolean;
  warning?: boolean;
};

export type ModalButton<R extends string> = {
  label: string;
  variant: ModalButtonVariant;
  result: R;
};

export type ModalPasswordInput = {
  kind: 'password';
  placeholder: string;
  hint?: string;
  error?: string;
};

export type ModalView<R extends string> = {
  title: string;
  /**
   * The dialog's test id, which names every id inside it. The caller's own, so ui names none of a domain's. A view
   * a dialog hands its place to keeps the first view's ids, so its own is ignored.
   */
  testId?: string;
  /** Drawn in the dialog's icon tile, which sizes it. */
  icon?: Component<IconProps>;
  fields: ModalField[];
  notice?: string;
  input?: ModalPasswordInput;
  /** Display order. */
  buttons: ModalButton<R>[];
  dismissOnBackdrop: boolean;
  /** Result of a backdrop click or Escape. Required when `dismissOnBackdrop`. */
  dismissResult?: R;
  /** Drawn in the body after fields and notice, for a step that is not a form. */
  body?: Component;
  /**
   * False hides the sheet head's close button. A swipe still closes and answers like the close button would.
   * Default true.
   */
  closable?: boolean;
};

/** The view an answered dialog shows in its place, until a button, Escape, the scrim or `signal` closes it. */
export type ModalHandoff = {
  view: ModalView<string>;
  /** Closes the step from elsewhere. */
  signal: AbortSignal;
  /** Hears once how it closed: a button's result, the view's `dismissResult`, or `aborted`. Must not throw. */
  closed: (result: string) => void;
};

export type ModalOutcome<R extends string> = {
  result: R;
  value?: string;
};

export type ModalEntry = {
  id: number;
  view: ModalView<string>;
};

type OpenParams<R extends string> = {
  /** Closes the dialog from elsewhere until it is answered. */
  signal?: AbortSignal | undefined;
  /** Hears the answer, and may return the view that takes the dialog's place. */
  handoff?: ((outcome: ModalOutcome<R>) => ModalHandoff | undefined) | undefined;
};

type SettleParams = {
  /** What the dialog's input holds. */
  value?: string | undefined;
};

type EntryBase = {
  resolve: (outcome: ModalOutcome<string>) => void;
  detach: () => void;
};

type DialogEntry = EntryBase & {
  kind: 'dialog';
  handoff?: ((outcome: ModalOutcome<string>) => ModalHandoff | undefined) | undefined;
  /** Rejects the dialog's promise, for a dialog that was disposed. */
  reject: (error: DOMException) => void;
};

type HandoffEntry = EntryBase & {
  kind: 'handoff';
  /** Tells a handed-off view that its dialog was disposed. */
  abandon: () => void;
};

type Pending = DialogEntry | HandoffEntry;

// An AbortError reason passes through and a string reason becomes the message, so this text shows only for others.
const MODAL_ABORTED = 'Blocking modal scope disposed';

/** Builds a dialog queue. The overlays show its first entry. */
export function createModals() {
  const pending = new Map<number, Pending>();
  let nextId = 0;

  // Registered before the store, so the pending dialogs detach before the store empties.
  registerStoreStateReset(resetState);

  const entries = atom<readonly ModalEntry[]>([]);
  registerAtomReset(entries);
  const store: ReadableAtom<readonly ModalEntry[]> = entries;
  // One listener serves every refuseAll caller, so a repeated call adds none.
  const refusing = createSharedRun({ begin: () => entries.listen(refuseOpen) });

  return {
    /** The open dialogs, oldest first. */
    store,
    /**
     * Queues `view` and resolves with its answer. Rejects with an AbortError when `signal` has fired or fires before
     * the answer, or when `dispose` drops the dialog, and with nothing else. Once answered, `handoff` may return
     * the view that takes the dialog's place without closing it. It sees every answer, refusals from `refuseAll`
     * included, so return `undefined` for those.
     */
    open,
    /**
     * Answers the dialog `id` with `result` and, for one with an input, `value`. A dialog already settled is ignored.
     * A `handoff` that throws is reported and the dialog closes as without one. Never throws.
     */
    settle,
    /**
     * Answers every open dialog with its refusal, and each one opened later, until the returned stop. For a page whose
     * overlays cannot render, so a product's request is refused at once rather than waiting until it aborts. A dialog
     * with no refusal stays open. Calling it again is safe: a dialog settles once.
     */
    refuseAll,
    /**
     * Rejects every open dialog with an AbortError, then tells each handed-off view `aborted`. Never throws, as
     * `closed` must not. A `closed` that throws anyway propagates after every open dialog has rejected, and the views
     * after it are not told. Safe to repeat. The queue works as a fresh one afterwards.
     */
    dispose,
  };

  function open<R extends string>(
    view: ModalView<R>,
    { signal, handoff }: OpenParams<R> = {},
  ): Promise<ModalOutcome<R>> {
    if (signal?.aborted === true) {
      return Promise.reject(toAbortError(signal.reason, MODAL_ABORTED));
    }
    const id = nextId++;
    return new Promise<ModalOutcome<R>>((resolve, reject) => {
      function rejectOnAbort(): void {
        if (take(id) !== undefined) {
          reject(toAbortError(signal?.reason, MODAL_ABORTED));
        }
      }
      signal?.addEventListener('abort', rejectOnAbort, { once: true });
      pending.set(id, {
        kind: 'dialog',
        // The queue holds every dialog's answers as plain strings, and this dialog only ever settles with its own `R`.
        handoff: handoff as DialogEntry['handoff'],
        // The queue settles this dialog only with one of its own results.
        resolve: resolve as (outcome: ModalOutcome<string>) => void,
        detach: () => {
          signal?.removeEventListener('abort', rejectOnAbort);
        },
        reject: error => {
          reject(error);
        },
      });
      entries.set([...entries.get(), { id, view }]);
    });
  }

  function settle(id: number, result: string, { value }: SettleParams = {}): void {
    const entry = pending.get(id);
    if (entry === undefined) {
      return;
    }
    const outcome: ModalOutcome<string> = value === undefined ? { result } : { result, value };
    let next: ModalHandoff | undefined;
    try {
      next = callHandoff(entry, outcome);
    } catch (error) {
      // The answer still reaches the caller, and the dialog closes as without a handoff.
      report.defect(error, {
        step: 'modal_handoff',
        tags: { kind: 'modal_handoff_error' },
        metric: modalHandoffMetric,
        message: '[dot.li modal] handoff failed, closing the dialog:',
      });
    }
    if (next !== undefined && !next.signal.aborted) {
      entry.detach();
      showHandoff(id, next);
    } else {
      take(id);
      next?.closed('aborted');
    }
    entry.resolve(outcome);
  }

  function refuseAll(): () => void {
    refuseOpen();
    return refusing.join();
  }

  function refuseOpen(): void {
    for (const entry of entries.get()) {
      const refusal = findRefusal(entry.view);
      if (refusal !== undefined) {
        settle(entry.id, refusal);
      }
    }
  }

  function take(id: number): Pending | undefined {
    const entry = pending.get(id);
    if (entry === undefined) {
      return undefined;
    }
    pending.delete(id);
    entry.detach();
    entries.set(entries.get().filter(shown => shown.id !== id));
    return entry;
  }

  /** Puts the handed-off view in the entry's place, closing it on its own signal. */
  function showHandoff(id: number, next: ModalHandoff): void {
    function closeOnAbort(): void {
      if (take(id) !== undefined) {
        next.closed('aborted');
      }
    }
    next.signal.addEventListener('abort', closeOnAbort, { once: true });
    pending.set(id, {
      kind: 'handoff',
      resolve: outcome => {
        next.closed(outcome.result);
      },
      detach: () => {
        next.signal.removeEventListener('abort', closeOnAbort);
      },
      abandon: () => {
        next.closed('aborted');
      },
    });
    entries.set(entries.get().map(shown => (shown.id === id ? { id, view: next.view } : shown)));
  }

  function dispose(): void {
    const dropped = detachAll();
    entries.set([]);
    // Rejecting cannot throw, so it runs first and a throwing `closed` leaves no dialog unsettled.
    for (const entry of dropped) {
      rejectDropped(entry);
    }
    for (const entry of dropped) {
      abandonDropped(entry);
    }
  }

  function resetState(): void {
    detachAll();
    nextId = 0;
  }

  function detachAll(): Pending[] {
    const all = [...pending.values()];
    pending.clear();
    for (const entry of all) {
      entry.detach();
    }
    return all;
  }
}

/** The page's dialog queue. */
export const modals = createModals();

function callHandoff(entry: Pending, outcome: ModalOutcome<string>): ModalHandoff | undefined {
  switch (entry.kind) {
    case 'dialog':
      return entry.handoff?.(outcome);
    case 'handoff':
      return undefined;
  }
}

function rejectDropped(entry: Pending): void {
  switch (entry.kind) {
    case 'dialog':
      entry.reject(toAbortError(undefined, MODAL_ABORTED));
      return;
    case 'handoff':
      return;
  }
}

function abandonDropped(entry: Pending): void {
  switch (entry.kind) {
    case 'dialog':
      return;
    case 'handoff':
      entry.abandon();
      return;
  }
}

/** A dialog's refusal: its dismiss result, else its cancel button's, else its danger button's. */
function findRefusal(view: ModalView<string>): string | undefined {
  return (
    view.dismissResult ??
    (
      view.buttons.find(button => button.variant === 'cancel') ??
      view.buttons.find(button => button.variant === 'danger')
    )?.result
  );
}
