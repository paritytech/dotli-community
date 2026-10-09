// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The overlays root renders the first entry. Everything that decides how a dialog settles lives
// here, outside Solid.

import { blockingModalAbortError } from '../blocking-modal-queue.js';
import { createSyncStore, type ReadableStore } from './create-store.js';

/**
 * `danger` rejects the request and is drawn destructive. `cancel` backs out of a prompt that is not a
 * request to reject. `secondary` is the lesser approval. `primary` is the main one, which Enter submits.
 */
export type ModalButtonVariant = 'cancel' | 'danger' | 'secondary' | 'primary';

export interface ModalField {
  label: string;
  value: string;
  mono?: boolean;
  warning?: boolean;
}

export interface ModalButton<R extends string> {
  label: string;
  variant: ModalButtonVariant;
  result: R;
}

export interface ModalChoice<R extends string> {
  label: string;
  result: R;
}

export interface ModalPasswordInput {
  kind: 'password';
  placeholder: string;
  hint?: string;
  error?: string;
}

export interface ModalView<R extends string> {
  title: string;
  /** SVG markup. */
  icon?: string;
  fields: ModalField[];
  notice?: string;
  input?: ModalPasswordInput;
  /** Host-owned choices, rendered separately from the action footer. */
  choices?: ModalChoice<R>[];
  /** Display order. */
  buttons: ModalButton<R>[];
  dismissOnBackdrop: boolean;
  /** Result of a backdrop click or Escape. Required when `dismissOnBackdrop`. */
  dismissResult?: R;
  /** Result when the overlays cannot render at all. */
  fallbackResult: R;
}

export interface ModalOutcome<R extends string> {
  result: R;
  value?: string;
}

export interface ModalEntry {
  id: number;
  view: ModalView<string>;
}

interface Pending {
  resolve: (outcome: ModalOutcome<string>) => void;
  fallbackResult: string;
  detach: () => void;
}

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

/** Rejects with an AbortError when `signal` fires. */
export function openModal<R extends string>(view: ModalView<R>, signal?: AbortSignal): Promise<ModalOutcome<R>> {
  if (signal?.aborted === true) {
    return Promise.reject(blockingModalAbortError(signal.reason));
  }
  const id = nextId++;
  return new Promise<ModalOutcome<R>>((resolve, reject) => {
    const onAbort = (): void => {
      if (take(id) !== undefined) {
        reject(blockingModalAbortError(signal?.reason));
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(id, {
      resolve: resolve as (outcome: ModalOutcome<string>) => void,
      fallbackResult: view.fallbackResult,
      detach: () => {
        signal?.removeEventListener('abort', onAbort);
      },
    });
    modals.set([...modals.get(), { id, view }]);
  });
}

/** Ignored if the dialog has already settled. */
export function settleModal(id: number, result: string, value?: string): void {
  take(id)?.resolve(value === undefined ? { result } : { result, value });
}

export function failAllModals(): void {
  for (const id of [...pending.keys()]) {
    const entry = take(id);
    entry?.resolve({ result: entry.fallbackResult });
  }
}

export function resetModalsForTests(): void {
  for (const entry of pending.values()) {
    entry.detach();
  }
  pending.clear();
  nextId = 0;
  modals.set([]);
}
