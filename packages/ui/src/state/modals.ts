// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The dialogs waiting to be shown, as plain data. The overlays root renders
// the first entry; everything that decides how a dialog settles (buttons,
// dismissal, abort, fallback) lives here, outside Solid.

import { blockingModalAbortError } from '../blocking-modal-queue.js';
import { createSyncStore, type ReadableStore } from './create-store.js';

export type ModalButtonVariant = 'cancel' | 'secondary' | 'primary';

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
  detail: string;
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
  /** SVG markup, rendered in `.permission-modal-icon`. */
  icon?: string;
  fields: ModalField[];
  notice?: string;
  input?: ModalPasswordInput;
  /** Host-owned choices, rendered separately from the action footer. */
  choices?: ModalChoice<R>[];
  /** Checkbox choices retain edits until a primary action confirms them. */
  selection?: { selected: readonly R[]; limit: number };
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
  /** The password input's value, for views with an input. */
  value?: string;
  /** Confirmed checkbox choices; absent on dismissal and fallback. */
  selected?: R[];
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

const modals = createSyncStore<readonly ModalEntry[]>([]);
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
 * Queue a dialog. Resolves with the chosen result once a button, a dismissal
 * or the fallback decides it; rejects with an AbortError when `signal` fires.
 */
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

/** Settle one dialog. Ignored if it has already settled. */
export function settleModal(id: number, result: string, value?: string, selected?: string[]): void {
  take(id)?.resolve({
    result,
    ...(value === undefined ? {} : { value }),
    ...(selected === undefined ? {} : { selected }),
  });
}

/** Settle every open dialog with its fallback result. */
export function failAllModals(): void {
  for (const id of [...pending.keys()]) {
    const entry = take(id);
    entry?.resolve({ result: entry.fallbackResult });
  }
}

/** Forget every dialog without settling it. Tests only. */
export function resetModalsForTests(): void {
  for (const entry of pending.values()) {
    entry.detach();
  }
  pending.clear();
  nextId = 0;
  modals.set([]);
}
