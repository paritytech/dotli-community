// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// ProfilePlatform host callbacks: `profile.present` from a product.
//
// The core has already screened the reference's shape. The host parses it,
// opens the drawer, and fetches and decrypts the avatar through its own
// preimage path. The call resolves once the drawer is up; fetch and decrypt
// failures are shown in the drawer, not returned, and nothing but success or
// a parse failure reaches the product.

import type { ProfilePlatform } from "@parity/truapi-host";
import { fromHex } from "@dotli/shared/hex";
import { showProfileDrawer } from "../profile/drawer";
import {
  openSeityBlob,
  parseSeityBlobReference,
} from "../profile/seity-reference";
import { createPreimageAdapters } from "./Preimage";

/** Bulletin retrieval can wait on bitswap providers attaching. */
const AVATAR_FETCH_TIMEOUT_MS = 90_000;

async function fetchCiphertext(
  preimageKey: `0x${string}`,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const deadline = AbortSignal.any([
    signal,
    AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
  ]);
  const { lookupPreimage } = createPreimageAdapters("profile");
  const iterator = lookupPreimage(fromHex(preimageKey))[Symbol.asyncIterator]();
  const stopped = new Promise<never>((_, reject) => {
    const abort = (): void => {
      // Timeout and close both abort with a DOMException, which the drawer
      // tells apart by name.
      reject(
        deadline.reason instanceof Error
          ? deadline.reason
          : new Error("profile fetch aborted"),
      );
    };
    if (deadline.aborted) {
      abort();
    }
    deadline.addEventListener("abort", abort, { once: true });
  });
  // Settled by whichever finishes first; never left as an unhandled rejection.
  stopped.catch(() => undefined);
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), stopped]);
      if (next.done === true) {
        throw new Error("preimage lookup ended without a value");
      }
      if (next.value.isErr()) {
        throw new Error(next.value.error.reason);
      }
      if (next.value.value !== undefined) {
        return new Uint8Array(next.value.value);
      }
    }
  } finally {
    void iterator.return?.();
  }
}

/**
 * Show the profile a reference names, attributed to `productId`. Throws for a
 * reference this host cannot parse, before any UI appears.
 */
export function presentProfileReference(
  productId: string,
  reference: string,
): void {
  const parsed = parseSeityBlobReference(reference);
  showProfileDrawer({
    productId,
    loadAvatar: async (signal) =>
      openSeityBlob(await fetchCiphertext(parsed.preimageKey, signal), parsed),
  });
}

export function createProfilePlatform(): Required<ProfilePlatform> {
  return {
    presentProfile(product, request) {
      // A parse failure thrown here rejects the call instead of escaping it.
      return new Promise<void>((resolve) => {
        presentProfileReference(product.productId, request.reference);
        resolve();
      });
    },
  };
}

/**
 * Debug builds only: `window.__dotliPresentProfile(reference)` opens the same
 * drawer a product's `profile.present` does, so the reader and the drawer can
 * be exercised without a product.
 */
export function installProfileDebugTrigger(): void {
  (
    window as typeof window & {
      __dotliPresentProfile?: (reference: string) => void;
    }
  ).__dotliPresentProfile = (reference) => {
    presentProfileReference("debug", reference);
  };
}
