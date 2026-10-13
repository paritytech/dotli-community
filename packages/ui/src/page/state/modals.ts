// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The overlays render the first entry. Everything that decides how a dialog settles lives
// here, outside Solid.

import { createSyncStore, toAbortError, type ReadableStore } from '@dotli/shared';
import type { Component } from 'solid-js';
import type { IconProps } from '../../components/icons/icon-props.js';

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

export interface ModalPasswordInput {
  kind: 'password';
  placeholder: string;
  hint?: string;
  error?: string;
}

export interface ModalView<R extends string> {
  title: string;
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
}

export interface ModalOutcome<R extends string> {
  result: R;
  value?: string;
}

/** How the page shows one dialog. */
export interface ModalOptions {
  /** Where focus goes back when the element the dialog came from left the page. */
  focusFallback?: (() => HTMLElement | undefined) | undefined;
}

export interface ModalEntry extends ModalOptions {
  id: number;
  view: ModalView<string>;
}

// An AbortError reason passes through and a string reason becomes the message, so this text shows only for others.
const MODAL_ABORTED = 'Blocking modal scope disposed';

interface Pending {
  resolve: (outcome: ModalOutcome<string>) => void;
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
export function openModal<R extends string>(
  view: ModalView<R>,
  signal?: AbortSignal,
  options: ModalOptions = {},
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
      resolve: resolve as (outcome: ModalOutcome<string>) => void,
      detach: () => {
        signal?.removeEventListener('abort', onAbort);
      },
    });
    modals.set([...modals.get(), { id, view, focusFallback: options.focusFallback }]);
  });
}

/** Ignored if the dialog has already settled. */
export function settleModal(id: number, result: string, value?: string): void {
  take(id)?.resolve(value === undefined ? { result } : { result, value });
}

export function resetModalsForTests(): void {
  for (const entry of pending.values()) {
    entry.detach();
  }
  pending.clear();
  nextId = 0;
  modals.set([]);
}
