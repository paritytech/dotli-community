// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Whether the product declares `includes.chat` in its worker manifest. The product frame picks the connection's
// execution kind from it, so the last answer is cached per label to keep warm loads off a dotNS read.

import { log, pageLocalStorage, type SafeStorage } from '@dotli/shared';

const CACHE_PREFIX = 'dotli:chat-capable:';

const chatLog = log.child({ flow: 'chat' });

/** Keeps the last answer per label for the next load. */
export type CapabilityCache = {
  get: (label: string) => boolean | null;
  set: (label: string, chat: boolean) => void;
};

/** A cache in `storage`. */
export function storageCapabilityCache(storage: Pick<SafeStorage, 'getItem' | 'setItem'>): CapabilityCache {
  return {
    get: label => {
      const raw = storage.getItem(`${CACHE_PREFIX}${label}`);
      return raw === null ? null : raw === '1';
    },
    set: (label, value) => {
      storage.setItem(`${CACHE_PREFIX}${label}`, value ? '1' : '0');
    },
  };
}

/**
 * Whether `label` declares chat: the cached answer when there is one, so it never waits on the read, else the read's.
 * The read refreshes the cache for the next load either way. An unreadable manifest means no chat for this load and
 * leaves the cached answer as it was.
 */
export function readChatCapability(
  label: string,
  read: () => Promise<boolean>,
  cache: CapabilityCache = storageCapabilityCache(pageLocalStorage),
): Promise<boolean> {
  const cached = cache.get(label);
  const fresh = read().then(
    chat => {
      cache.set(label, chat);
      return chat;
    },
    (err: unknown) => {
      chatLog.warn('[dot.li chat] worker manifest unreadable, chat is off for this load:', err);
      return false;
    },
  );
  return cached === null ? fresh : Promise.resolve(cached);
}
