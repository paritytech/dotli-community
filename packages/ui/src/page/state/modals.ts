// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The overlays render the first entry. Everything that decides how a dialog settles lives
// here, outside Solid.

import {
  createSyncStore,
  errorName,
  log,
  registerStoreStateReset,
  toAbortError,
  type ReadableStore,
} from '@dotli/shared';
import { captureException, m, spans as S } from '@dotli/metrics';
import type { Component } from 'solid-js';
import type { IconProps } from '../../components/icons/icon-props.js';

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
  /** Hears once how it closed: a button's result, the view's `dismissResult`, or `aborted`. */
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

// An AbortError reason passes through and a string reason becomes the message, so this text shows only for others.
const MODAL_ABORTED = 'Blocking modal scope disposed';

type Pending = {
  handoff?: ((outcome: ModalOutcome<string>) => ModalHandoff | undefined) | undefined;
  resolve: (outcome: ModalOutcome<string>) => void;
  detach: () => void;
};

// Registered before the store, so the pending dialogs detach before the store empties.
registerStoreStateReset(resetModalState);

const modals = createSyncStore<readonly ModalEntry[]>('modals', []);
export const modalsStore: ReadableStore<readonly ModalEntry[]> = modals;

const pending = new Map<number, Pending>();
let nextId = 0;

function take(id: number): Pending | undefined {
  const entry = pending.get(id);
  if (entry === undefined) {
    return undefined;
  }
  pending.delete(id);
  entry.detach();
  modals.set(modals.get().filter(e => e.id !== id));
  return entry;
}

/**
 * Rejects with an AbortError when `signal` fires, until the dialog is answered. Once answered, `handoff` may return
 * the view that takes the dialog's place without closing it. It sees every answer, refusals from `refuseModals`
 * included, so return `undefined` for those.
 */
export function openModal<R extends string>(
  view: ModalView<R>,
  signal?: AbortSignal,
  handoff?: (outcome: ModalOutcome<R>) => ModalHandoff | undefined,
): Promise<ModalOutcome<R>> {
  if (signal?.aborted === true) {
    return Promise.reject(toAbortError(signal.reason, MODAL_ABORTED));
  }
  const id = nextId++;
  return new Promise<ModalOutcome<R>>((resolve, reject) => {
    const onAbort = (): void => {
      if (take(id) !== undefined) {
        reject(toAbortError(signal?.reason, MODAL_ABORTED));
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(id, {
      handoff: handoff as Pending['handoff'],
      resolve: resolve as (outcome: ModalOutcome<string>) => void,
      detach: () => {
        signal?.removeEventListener('abort', onAbort);
      },
    });
    modals.set([...modals.get(), { id, view }]);
  });
}

/** Puts the handed-off view in the entry's place, closing it on its own signal. */
function showHandoff(id: number, next: ModalHandoff): void {
  const onAbort = (): void => {
    if (take(id) !== undefined) {
      next.closed('aborted');
    }
  };
  next.signal.addEventListener('abort', onAbort, { once: true });
  pending.set(id, {
    resolve: outcome => {
      next.closed(outcome.result);
    },
    detach: () => {
      next.signal.removeEventListener('abort', onAbort);
    },
  });
  modals.set(modals.get().map(e => (e.id === id ? { id, view: next.view } : e)));
}

/** Ignored if the dialog has already settled. */
export function settleModal(id: number, result: string, value?: string): void {
  const entry = pending.get(id);
  if (entry === undefined) {
    return;
  }
  const outcome: ModalOutcome<string> = value === undefined ? { result } : { result, value };
  let next: ModalHandoff | undefined;
  try {
    next = entry.handoff?.(outcome);
  } catch (err) {
    // The answer still reaches the caller, and the dialog closes as without a handoff.
    captureException(err, { flow: 'ui', step: 'modal_handoff', tags: { kind: 'modal_handoff_error' } });
    log.error('[dot.li modal] handoff failed, closing the dialog:', err);
    m.count(S.MODAL_HANDOFF, { outcome: 'error', reason: errorName(err) ?? 'unknown' });
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

/** A dialog's refusal: its dismiss result, else its cancel or reject button's. */
function refusalOf(view: ModalView<string>): string | undefined {
  return view.dismissResult ?? view.buttons.find(b => b.variant === 'cancel' || b.variant === 'danger')?.result;
}

/**
 * Answers every open dialog with its refusal, and each one opened later, until the returned stop. For a page whose
 * overlays cannot render, so a product's request is refused at once rather than waiting until it aborts. A dialog with
 * no refusal stays open. Calling it again is safe: a dialog settles once.
 */
export function refuseModals(): () => void {
  const refuseOpen = (): void => {
    for (const entry of modals.get()) {
      const refusal = refusalOf(entry.view);
      if (refusal !== undefined) {
        settleModal(entry.id, refusal);
      }
    }
  };
  refuseOpen();
  return modals.subscribe(refuseOpen);
}

function resetModalState(): void {
  for (const entry of pending.values()) {
    entry.detach();
  }
  pending.clear();
  nextId = 0;
}
