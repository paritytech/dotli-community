// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProductStorage } from '@parity/truapi-host';
import type { HostLocalStorageChangeItem } from '@parity/truapi';
import { bytesToHex } from '@parity/truapi/scale';
import { base64 } from '@scure/base';
import { reportExpected, reportListener, spans as S } from '@dotli/metrics';
import { createListenerSet } from '@dotli/shared';
import { ERRORS } from '../errors.js';
import { createResultStream } from './result-stream.js';

// Same-window writes fire no `storage` event, so runtimes in this window (app frames and the chat
// worker) hear through this set. Other tabs get the `storage` event.
type StorageListener = (key: string) => void;
const listeners = createListenerSet<string>({ onListenerError: reportListener('storage', 'local_storage.change') });

function notifyChanged(key: string): void {
  listeners.emit(key);
}

export interface ProductStorageDeps {
  /** Reached on every call, as the page's localStorage throws where the browser blocks it. */
  storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** Where other tabs' `storage` events arrive. */
  events: () => EventTarget;
}

const pageStorage: ProductStorageDeps = { storage: () => localStorage, events: () => window };

export function createLocalStorageRead({ storage }: ProductStorageDeps = pageStorage): ProductStorage['read'] {
  return key => {
    try {
      const raw = storage().getItem(storageKey(key));
      if (raw === null) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(base64.decode(raw));
    } catch (cause) {
      return Promise.reject(new Error(ERRORS.STORAGE_READ_FAILED, { cause }));
    }
  };
}

export function createLocalStorageWrite({ storage }: ProductStorageDeps = pageStorage): ProductStorage['write'] {
  return (key, value) => {
    try {
      storage().setItem(storageKey(key), base64.encode(value));
      notifyChanged(key);
      return Promise.resolve();
    } catch (cause) {
      return Promise.reject(new Error(ERRORS.STORAGE_WRITE_FAILED, { cause }));
    }
  };
}

export function createLocalStorageClear({ storage }: ProductStorageDeps = pageStorage): ProductStorage['clear'] {
  return key => {
    try {
      storage().removeItem(storageKey(key));
      notifyChanged(key);
      return Promise.resolve();
    } catch (cause) {
      return Promise.reject(new Error(ERRORS.STORAGE_CLEAR_FAILED, { cause }));
    }
  };
}

// The core drops items repeating the last delivered value, so every write is
// forwarded without comparing bytes here.
export function createLocalStorageSubscribe({
  storage,
  events,
}: ProductStorageDeps = pageStorage): ProductStorage['subscribeStorage'] {
  return key =>
    createResultStream<HostLocalStorageChangeItem>([], (push, pushError) => {
      const emit = (): void => {
        try {
          const raw = storage().getItem(storageKey(key));
          push(raw === null ? {} : { value: bytesToHex(base64.decode(raw)) });
        } catch (err) {
          // The browser blocking storage is the environment, so the product hears a read failure and the page keeps
          // the cause as a breadcrumb.
          reportExpected(err, {
            flow: 'storage',
            step: 'product_storage_watch',
            metric: S.PRODUCT_STORAGE_WATCH,
            message: '[dot.li] product storage read for a subscription failed:',
          });
          pushError({ reason: ERRORS.STORAGE_READ_FAILED });
        }
      };
      const onLocalChange: StorageListener = changed => {
        if (changed === key) {
          emit();
        }
      };
      const onStorage = (event: Event): void => {
        const changed = (event as StorageEvent).key;
        // `key === null` is a whole-storage `clear()` from another tab.
        if (changed === null || changed === storageKey(key)) {
          emit();
        }
      };
      const target = events();
      const unsubscribe = listeners.subscribe(onLocalChange);
      target.addEventListener('storage', onStorage);
      emit();
      return () => {
        unsubscribe();
        target.removeEventListener('storage', onStorage);
      };
    });
}

function storageKey(key: string): string {
  return `dotli:${key}`;
}
