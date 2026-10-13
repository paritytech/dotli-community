// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Whether the product declares `includes.chat` in its worker manifest. The bridge picks the connection's
// execution kind from it, so the last value is cached per label to keep warm loads off a dotNS read.

import { log } from '@dotli/shared';

const CACHE_PREFIX = 'dotli:chat-capable:';

const chatLog = log.child({ flow: 'chat' });

/** Keeps the last answer per label for the next load. */
export interface CapabilityCache {
  get: (label: string) => boolean | null;
  set: (label: string, chat: boolean) => void;
}

/** A cache in `storage`, reached on each use since the page's localStorage can throw on access. */
export function storageCapabilityCache(storage: () => Pick<Storage, 'getItem' | 'setItem'>): CapabilityCache {
  return {
    get: label => {
      try {
        const raw = storage().getItem(`${CACHE_PREFIX}${label}`);
        return raw === null ? null : raw === '1';
      } catch {
        return null;
      }
    },
    set: (label, value) => {
      try {
        storage().setItem(`${CACHE_PREFIX}${label}`, value ? '1' : '0');
        // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable in private mode, which only loses the warm-start shortcut.
      } catch {
        /* capability still resolves for this load */
      }
    },
  };
}

export interface ChatCapability {
  /** Calls back with each answer for `label`, at once with one that already settled, until unsubscribed. */
  subscribe: (label: string, listener: (chat: boolean) => void) => () => void;
  /**
   * Prime the capability, answering from cache when present while `resolve` refreshes it for the next load.
   * The first answer sticks for the whole load, because the bridge fixes the execution kind from it.
   */
  prime: (label: string, resolve: () => Promise<boolean>) => void;
  /** Force a known capability, used by the localhost product debug path. */
  set: (label: string, chat: boolean) => void;
  /** Resolves `false` when nothing was primed or a different product is active. */
  capabilityFor: (label: string) => Promise<boolean>;
}

/** The capability of the active product, cached in `cache` between loads. */
export function createChatCapability(
  cache: CapabilityCache = storageCapabilityCache(() => localStorage),
): ChatCapability {
  let activeLabel: string | null = null;
  let activePromise: Promise<boolean> | null = null;
  let settled: { label: string; chat: boolean } | null = null;
  const listeners = new Map<string, Set<(chat: boolean) => void>>();

  function announce(label: string, chat: boolean): void {
    settled = { label, chat };
    for (const listener of [...(listeners.get(label) ?? [])]) {
      // A broken subscriber must not reject the answer this announce completes.
      try {
        listener(chat);
      } catch (error) {
        chatLog.error('[dot.li chat] a chat capability subscriber failed:', error);
      }
    }
  }

  return {
    subscribe: (label, listener) => {
      const forLabel = listeners.get(label) ?? new Set();
      listeners.set(label, forLabel);
      forLabel.add(listener);
      if (settled?.label === label) {
        listener(settled.chat);
      }
      return () => {
        forLabel.delete(listener);
        if (forLabel.size === 0 && listeners.get(label) === forLabel) {
          listeners.delete(label);
        }
      };
    },
    prime: (label, resolve) => {
      activeLabel = label;
      const cached = cache.get(label);
      const fresh = resolve().then(
        value => {
          cache.set(label, value);
          announce(label, cached ?? value);
          return cached ?? value;
        },
        (err: unknown) => {
          // Keep the cached value for the next load rather than overwriting it with a failure.
          chatLog.warn('[dot.li chat] worker manifest unreadable, chat is off for this load:', err);
          announce(label, cached ?? false);
          return cached ?? false;
        },
      );
      activePromise = cached === null ? fresh : Promise.resolve(cached);
      if (cached !== null) {
        announce(label, cached);
      }
    },
    set: (label, chat) => {
      activeLabel = label;
      activePromise = Promise.resolve(chat);
      announce(label, chat);
    },
    capabilityFor: label => {
      if (activeLabel !== label || activePromise === null) {
        return Promise.resolve(false);
      }
      return activePromise;
    },
  };
}

const page = createChatCapability();

/** {@link ChatCapability.subscribe} on the page's capability. */
export function subscribeChatCapability(label: string, listener: (chat: boolean) => void): () => void {
  return page.subscribe(label, listener);
}

/** {@link ChatCapability.prime} on the page's capability. */
export function primeChatCapability(label: string, resolve: () => Promise<boolean>): void {
  page.prime(label, resolve);
}

/** {@link ChatCapability.set} on the page's capability. */
export function setChatCapability(label: string, chat: boolean): void {
  page.set(label, chat);
}

/** {@link ChatCapability.capabilityFor} on the page's capability. */
export function chatCapabilityFor(label: string): Promise<boolean> {
  return page.capabilityFor(label);
}
