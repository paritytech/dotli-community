// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Whether the product declares `includes.chat` in its worker manifest. The bridge picks the connection's
// execution kind from it, so the last value is cached per label to keep warm loads off a dotNS read.

import { log } from './log.js';

const CACHE_PREFIX = 'dotli:chat-capable:';

/** Window event announcing a settled chat capability for a label. */
export const CHAT_AVAILABILITY_EVENT = 'dotli:chat-availability';

export interface ChatAvailabilityDetail {
  label: string;
  chat: boolean;
}

let activeLabel: string | null = null;
let activePromise: Promise<boolean> | null = null;

function readCache(label: string): boolean | null {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${label}`);
    return raw === null ? null : raw === '1';
  } catch {
    return null;
  }
}

function writeCache(label: string, value: boolean): void {
  try {
    localStorage.setItem(`${CACHE_PREFIX}${label}`, value ? '1' : '0');
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable in private mode, which only loses the warm-start shortcut.
  } catch {
    /* capability still resolves for this load */
  }
}

function announce(label: string, chat: boolean): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<ChatAvailabilityDetail>(CHAT_AVAILABILITY_EVENT, {
      detail: { label, chat },
    }),
  );
}

/**
 * Prime the capability, answering from cache when present while `resolve` refreshes it for the next load.
 * The first answer sticks for the whole load, because the bridge fixes the execution kind from it.
 */
export function primeChatCapability(label: string, resolve: () => Promise<boolean>): void {
  activeLabel = label;
  const cached = readCache(label);
  const fresh = resolve().then(
    value => {
      writeCache(label, value);
      announce(label, cached ?? value);
      return cached ?? value;
    },
    (err: unknown) => {
      // Keep the cached value for the next load rather than overwriting it with a failure.
      log.child({ flow: 'chat' }).warn('[dot.li chat] worker manifest unreadable, chat is off for this load:', err);
      announce(label, cached ?? false);
      return cached ?? false;
    },
  );
  activePromise = cached === null ? fresh : Promise.resolve(cached);
  if (cached !== null) {
    announce(label, cached);
  }
}

/** Force a known capability, used by the localhost product debug path. */
export function setChatCapability(label: string, chat: boolean): void {
  activeLabel = label;
  activePromise = Promise.resolve(chat);
  announce(label, chat);
}

/** Resolves `false` when nothing was primed or a different product is active. */
export function chatCapabilityFor(label: string): Promise<boolean> {
  if (activeLabel !== label || activePromise === null) {
    return Promise.resolve(false);
  }
  return activePromise;
}

export function resetChatCapabilityForTests(): void {
  activeLabel = null;
  activePromise = null;
}
