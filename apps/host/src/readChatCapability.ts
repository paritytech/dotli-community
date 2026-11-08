// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Whether the product declares `includes.chat` in its worker manifest. The product frame picks the connection's
// execution kind from it, so the last answer is cached per label to keep warm loads off a dotNS read.

import { createReporter, defineCount } from '@dotli/metrics';
import { pageLocalStorage, type SafeStorage } from '@dotli/shared';

const report = createReporter({ flow: 'chat' });

/**
 * Count. The worker manifest read that tells whether a product declares chat failed, so chat is off for that load.
 * Tagged `outcome` (error) and `reason` (the error's name).
 */
const chatCapabilityMetric = defineCount<'error'>('chat.capability');

/** Keeps the last answer per label for the next load. */
export type CapabilityCache = ReturnType<typeof createStorageCapabilityCache>;

type ReadChatCapabilityParams = {
  /** Where the last answer is kept, the page's local storage by default. */
  cache?: CapabilityCache | undefined;
};

type CreateStorageCapabilityCacheParams = {
  /** Where the answers are kept, which never throws. */
  storage: Pick<SafeStorage, 'getItem' | 'setItem'>;
};

const CACHE_PREFIX = 'dotli:chat-capable:';

/**
 * Whether `label` declares chat: the cached answer when there is one, so it never waits on the read, else the read's.
 * The read refreshes the cache for the next load either way. An unreadable manifest means no chat for this load and
 * leaves the cached answer as it was. Never rejects.
 */
export function readChatCapability(
  label: string,
  read: () => Promise<boolean>,
  { cache = createStorageCapabilityCache({ storage: pageLocalStorage }) }: ReadChatCapabilityParams = {},
): Promise<boolean> {
  const cached = cache.get(label);
  const fresh = read().then(
    chat => {
      cache.set(label, chat);
      return chat;
    },
    (error: unknown) => {
      report.defect(error, {
        step: 'capability_read',
        metric: chatCapabilityMetric,
        message: '[dot.li chat] worker manifest unreadable, chat is off for this load:',
      });
      return false;
    },
  );
  return cached === null ? fresh : Promise.resolve(cached);
}

/** Builds a cache in `storage`. Never throws. */
export function createStorageCapabilityCache({ storage }: CreateStorageCapabilityCacheParams) {
  return {
    /** Returns the kept answer for `label`, or null when none is kept. Never throws. */
    get(label: string): boolean | null {
      const raw = storage.getItem(`${CACHE_PREFIX}${label}`);
      return raw === null ? null : raw === '1';
    },
    /** Keeps `chat` as the answer for `label`. Never throws. */
    set(label: string, chat: boolean): void {
      storage.setItem(`${CACHE_PREFIX}${label}`, chat ? '1' : '0');
    },
  };
}
