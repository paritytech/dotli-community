// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProductStorage } from '@parity/truapi-host';
import type { HostLocalStorageChangeItem } from '@parity/truapi';
import { base64 } from '@scure/base';
import { createReporter, defineCount } from '@dotli/metrics';
import { createListenerSet, toHex } from '@dotli/shared';
import { ERRORS } from '../errors.js';
import { createResultStream } from './createResultStream.js';

const report = createReporter({ flow: 'storage' });

/**
 * A read of a product's storage for its subscription that failed. Tagged `outcome` (error) and `reason` (the error's
 * name), as the product then hears only a read failure.
 */
const productStorageWatchMetric = defineCount<'error'>('product_storage.watch');

/** The part of another tab's `storage` event the subscription reads. */
type StorageChange = Pick<StorageEvent, 'key'>;

/** Hears other tabs' `storage` events. */
type StorageEventTarget = {
  /** Adds `listener` for each `storage` event. Never throws. */
  addEventListener(type: 'storage', listener: (event: StorageChange) => void): void;
  /** Removes `listener`. Never throws. */
  removeEventListener(type: 'storage', listener: (event: StorageChange) => void): void;
};

export type LocalStorageCallbacksParams = {
  /**
   * Reached on every call, as the page's localStorage throws where the browser blocks it. The page's localStorage by
   * default.
   */
  storage?: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** Where other tabs' `storage` events arrive. The page's window by default. */
  events?: () => StorageEventTarget;
};

/**
 * Serves a product's local storage over one store. Same-window writes fire no `storage` event, so the runtimes that
 * share one instance hear each other's writes through it, and other tabs through the `storage` event.
 */
export function createLocalStorageCallbacks({
  storage = () => localStorage,
  events = () => window,
}: LocalStorageCallbacksParams = {}) {
  const listeners = createListenerSet<string>({ onListenerError: report.listener('local_storage.change') });

  function notifyChanged(key: string): void {
    listeners.emit(key);
  }

  function read(key: string): ReturnType<ProductStorage['read']> {
    try {
      const raw = storage().getItem(getStorageKey(key));
      if (raw === null) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(base64.decode(raw));
    } catch (cause) {
      return Promise.reject(new Error(ERRORS.STORAGE_READ_FAILED, { cause }));
    }
  }

  function write(key: string, value: Uint8Array): ReturnType<ProductStorage['write']> {
    try {
      storage().setItem(getStorageKey(key), base64.encode(value));
      notifyChanged(key);
      return Promise.resolve();
    } catch (cause) {
      return Promise.reject(new Error(ERRORS.STORAGE_WRITE_FAILED, { cause }));
    }
  }

  function clear(key: string): ReturnType<ProductStorage['clear']> {
    try {
      storage().removeItem(getStorageKey(key));
      notifyChanged(key);
      return Promise.resolve();
    } catch (cause) {
      return Promise.reject(new Error(ERRORS.STORAGE_CLEAR_FAILED, { cause }));
    }
  }

  // Every write is forwarded without comparing bytes, so a repeat of the last value streams again.
  function subscribe(key: string): ReturnType<ProductStorage['subscribeStorage']> {
    return createResultStream<HostLocalStorageChangeItem>([], (push, pushError) => {
      function emit(): void {
        try {
          const raw = storage().getItem(getStorageKey(key));
          push(raw === null ? {} : { value: toHex(base64.decode(raw)) });
        } catch (error) {
          // The browser blocking storage is the environment, so the product hears a read failure and the page keeps
          // the cause as a breadcrumb.
          report.expected(error, {
            step: 'product_storage_watch',
            metric: productStorageWatchMetric,
            message: '[dot.li] product storage read for a subscription failed:',
          });
          pushError({ reason: ERRORS.STORAGE_READ_FAILED });
        }
      }

      function handleLocalChange(changed: string): void {
        if (changed === key) {
          emit();
        }
      }

      function handleStorage({ key: changed }: StorageChange): void {
        // `key === null` is a whole-storage `clear()` from another tab.
        if (changed === null || changed === getStorageKey(key)) {
          emit();
        }
      }

      function dispose(): void {
        unsubscribe();
        target.removeEventListener('storage', handleStorage);
      }

      const target = events();
      const unsubscribe = listeners.subscribe(handleLocalChange);
      target.addEventListener('storage', handleStorage);
      emit();
      return dispose;
    });
  }

  return {
    /** Reads the bytes at `key`, or undefined when none are stored. Rejects with the read failure text. */
    read,
    /** Stores `value` at `key` and tells this instance's subscribers. Rejects with the write failure text. */
    write,
    /** Removes the value at `key` and tells this instance's subscribers. Rejects with the clear failure text. */
    clear,
    /**
     * Streams the value at `key` now and after each write or clear through this instance or in another tab. A read
     * that fails yields one error item with the read failure text, and the stream then ends.
     */
    subscribe,
  };
}

/** The page's product storage, which every core on the page shares. */
export const localStorageCallbacks = createLocalStorageCallbacks();

function getStorageKey(key: string): string {
  return `dotli:${key}`;
}
