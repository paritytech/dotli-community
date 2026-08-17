// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Whether the loaded product declares chat support, read from the worker
// executable manifest's `includes.chat` on `worker.<label>.<tld>`.
//
// The host shell primes this before rendering so the TrUAPI bridge can
// pick the product connection's execution kind ("Chat" vs "Spa") when it
// creates the provider, and the topbar can gate the chat button. The last
// resolved value is cached in localStorage per label so warm loads (cached
// CID) do not stall provider creation on a dotNS text-record read.

const CACHE_PREFIX = "dotli:chat-capable:";

/** Window event announcing a settled chat capability for a label. */
export const CHAT_AVAILABILITY_EVENT = "dotli:chat-availability";

export interface ChatAvailabilityDetail {
  label: string;
  chat: boolean;
}

let activeLabel: string | null = null;
let activePromise: Promise<boolean> | null = null;

function readCache(label: string): boolean | null {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${label}`);
    return raw === null ? null : raw === "1";
  } catch {
    return null;
  }
}

function writeCache(label: string, value: boolean): void {
  try {
    localStorage.setItem(`${CACHE_PREFIX}${label}`, value ? "1" : "0");
    // eslint-disable-next-line no-restricted-syntax -- localStorage may be unavailable (private mode); only the warm-start shortcut is lost.
  } catch {
    /* capability still resolves for this load */
  }
}

function announce(label: string, chat: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<ChatAvailabilityDetail>(CHAT_AVAILABILITY_EVENT, {
      detail: { label, chat },
    }),
  );
}

/**
 * Prime the capability for the product being rendered. The cached value
 * answers immediately when present; `resolve` always runs to refresh the
 * cache and re-announce, so a stale cache corrects itself on the next load.
 */
export function primeChatCapability(
  label: string,
  resolve: () => Promise<boolean>,
): void {
  activeLabel = label;
  const cached = readCache(label);
  const fresh = resolve().then(
    (value) => {
      writeCache(label, value);
      announce(label, value);
      return value;
    },
    () => {
      // An unreadable manifest means no chat this load; keep any cached
      // value for the next one rather than overwriting it with a failure.
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

/**
 * Capability for `label`, resolving `false` when nothing was primed or a
 * different product is active.
 */
export function chatCapabilityFor(label: string): Promise<boolean> {
  if (activeLabel !== label || activePromise === null) {
    return Promise.resolve(false);
  }
  return activePromise;
}

/** Reset module state (tests only). */
export function resetChatCapabilityForTests(): void {
  activeLabel = null;
  activePromise = null;
}
