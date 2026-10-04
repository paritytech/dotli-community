// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// ProfilePlatform host callbacks: `profile.present`, `profile.presentContact`
// and the contact avatars a product places.
//
// The core has already screened the reference's shape. The host parses it,
// opens the drawer, and fetches and decrypts the avatar through its own
// preimage path. The call resolves once the drawer is up; fetch and decrypt
// failures are shown in the drawer, not returned, and nothing but success or
// a parse failure reaches the product.
//
// Placed avatars are drawn on the host's layer over the product frame from
// the same loader, and every placement answers success: the product must not
// learn which of its contacts shared a profile.

import type { ProfilePlatform } from '@parity/truapi-host';
import { bytesToHex } from '@parity/truapi/scale';
import { fromHex, log } from '@dotli/shared';
import { showProfileDrawer, type LoadedProfile, type ProfileDrawerOptions } from '../profile/drawer.js';
import {
  createAvatarProfileCache,
  createContactAvatarOverlay,
  type ContactAvatarOverlay,
} from '../profile/avatar-overlay.js';
import {
  isContactsReference,
  openContactsRecord,
  parseContactsReference,
  type SeityContactsReference,
} from '../profile/contacts-reference.js';
import { decodeProfileRecord } from '../profile/profile-record.js';
import { openSeityBlob, parseSeityBlobReference } from '../profile/seity-reference.js';
import { resolveSeitySlotRemote, type RemoteSeitySlot } from '@dotli/protocol';
import { getBackend } from '@dotli/config';
import { loadRpcResolve } from '@dotli/resolver';
import { createPreimageAdapters } from './Preimage.js';
import type { NativeChatContactsDirectory } from './Contacts.js';

/** Bulletin retrieval can wait on bitswap providers attaching. */
const AVATAR_FETCH_TIMEOUT_MS = 90_000;

async function fetchCiphertext(preimageKey: `0x${string}`, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS)]);
  const { lookupPreimage } = createPreimageAdapters('profile');
  const iterator = lookupPreimage(fromHex(preimageKey))[Symbol.asyncIterator]();
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => {
      reject(
        deadline.reason instanceof Error ? deadline.reason : new DOMException('Profile load cancelled', 'AbortError'),
      );
    };
    if (deadline.aborted) {
      abort();
    } else {
      deadline.addEventListener('abort', abort, { once: true });
    }
  });
  // Settled by whichever finishes first; never left as an unhandled rejection.
  stopped.catch(() => undefined);
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), stopped]);
      if (next.done === true) {
        throw new Error('preimage lookup ended without a value');
      }
      if (next.value.isErr()) {
        throw new Error(next.value.error.reason);
      }
      if (next.value.value !== undefined) {
        return new Uint8Array(next.value.value);
      }
    }
  } finally {
    if (abort !== undefined) {
      deadline.removeEventListener('abort', abort);
    }
    void iterator.return?.();
  }
}

/**
 * Show the profile a reference names, attributed to `productId`. Rejects for a
 * reference this host cannot parse, before any UI appears.
 */
export async function presentProfileReference(
  productId: string,
  reference: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await showProfileDrawer({
    productId,
    loadProfile: profileLoader(reference),
    ...(signal === undefined ? {} : { signal }),
  });
}

/** How a contact the host knows no username for is named. */
const UNNAMED_CONTACT = 'this contact';

/**
 * Show a contact's shared profile or an empty-profile view when no reference
 * has arrived. Names come from the core's verified contact directory, never
 * from an address or the requesting product. A malformed reference fails
 * before presentation; it is not treated as absent sharing.
 */
export async function presentContactProfileReference(
  productId: string,
  reference: string | undefined,
  username: string | undefined,
  signal?: AbortSignal,
  loadContactName?: ProfileDrawerOptions['loadContactName'],
): Promise<void> {
  signal?.throwIfAborted();
  await showProfileDrawer({
    productId,
    contactName: username === undefined || username === '' ? UNNAMED_CONTACT : username,
    ...(reference === undefined ? {} : { loadProfile: profileLoader(reference) }),
    ...(loadContactName === undefined ? {} : { loadContactName }),
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * Parse a reference into the loader the drawer runs. Throws for a reference
 * this host cannot parse, so no UI appears for it.
 *
 * - `seity-contacts:v1:…` names a registry slot: read it, fetch and open the
 *   sealed record, then fetch and open the avatar the record names.
 * - A bare `cid#key` names one avatar blob (the #287 path, unchanged).
 */
function profileLoader(reference: string): (signal: AbortSignal) => Promise<LoadedProfile> {
  if (isContactsReference(reference)) {
    const parsed = parseContactsReference(reference);
    return signal => loadContactsProfile(parsed, signal);
  }
  const parsed = parseSeityBlobReference(reference);
  return async signal => ({
    avatar: await openSeityBlob(await fetchCiphertext(parsed.preimageKey, signal), parsed),
  });
}

/**
 * Read the registry slot through whichever chain path is active: the protocol
 * worker's light client, or the gateway RPC for "Trusted Providers", which
 * does not route resolution through the protocol iframe.
 */
async function readSeitySlot(lookupKey: `0x${string}`): Promise<RemoteSeitySlot | null> {
  if (getBackend() === 'rpc-gateway') {
    const { resolveSeitySlotViaRpc } = await loadRpcResolve();
    const slot = await resolveSeitySlotViaRpc(lookupKey);
    return slot === null ? null : { ...slot, version: slot.version.toString() };
  }
  return resolveSeitySlotRemote(lookupKey);
}

async function loadContactsProfile(reference: SeityContactsReference, signal: AbortSignal): Promise<LoadedProfile> {
  signal.throwIfAborted();
  const slot = await readSeitySlot(reference.lookupKey);
  signal.throwIfAborted();
  // Never anchored, revoked (zero digest) or no registry: nothing to show.
  if (slot === null || slot.version === '0' || /^0x0{64}$/.test(slot.cidDigest)) {
    return { avatar: null };
  }
  const sealed = await fetchCiphertext(slot.cidDigest, signal);
  const record = decodeProfileRecord(await openContactsRecord(sealed, reference));
  signal.throwIfAborted();
  if (record.avatarReference === undefined) {
    return { avatar: null, ...(record.mood === undefined ? {} : { mood: record.mood }) };
  }
  // An avatar that cannot be fetched or opened still leaves the mood, which
  // the drawer shows on its own.
  const avatar = await openAvatar(record.avatarReference, signal).catch(() => {
    signal.throwIfAborted();
    return null;
  });
  return { avatar, ...(record.mood === undefined ? {} : { mood: record.mood }) };
}

async function openAvatar(reference: string, signal: AbortSignal): Promise<Uint8Array> {
  const parsed = parseSeityBlobReference(reference);
  return openSeityBlob(await fetchCiphertext(parsed.preimageKey, signal), parsed);
}

/** A product frame's avatar layer, with capabilities retired when it closes. */
export function createContactAvatars(): ContactAvatarOverlay {
  const cache = createAvatarProfileCache(profileLoader, 0);
  const overlay = createContactAvatarOverlay(cache);
  let disposed = false;
  return {
    ...overlay,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      overlay.dispose();
      cache.clear();
    },
  };
}

/**
 * `avatars` is the layer of the frame this connection serves. Connections
 * without a frame (the landing and wallet hosts) draw nothing.
 */
export function createProfilePlatform(
  avatars: ContactAvatarOverlay | null = null,
  signal?: AbortSignal,
  contactsDirectory?: NativeChatContactsDirectory,
): Required<ProfilePlatform> {
  return {
    presentProfile(product, request) {
      return presentProfileReference(product.productId, request.reference, signal);
    },
    presentContactProfile(product, presented) {
      const username = presented.username?.trim();
      return presentContactProfileReference(
        product.productId,
        presented.shared?.reference,
        username,
        signal,
        (username !== undefined && username !== '') || contactsDirectory === undefined
          ? undefined
          : async presentationSignal => {
              const lookupSignal = AbortSignal.any([
                presentationSignal,
                contactsDirectory.signal,
                AbortSignal.timeout(2_000),
              ]);
              const snapshot = await contactsDirectory.snapshot(lookupSignal);
              const peerIdentity = bytesToHex(presented.peerIdentity);
              const name = snapshot.contacts.find(contact => contact.peerIdentity === peerIdentity)?.username?.trim();
              return name === '' ? undefined : name;
            },
      );
    },
    placeContactAvatars(_product, placed) {
      return Promise.resolve().then(() => {
        signal?.throwIfAborted();
        avatars?.place(placed);
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
  ).__dotliPresentProfile = reference => {
    void presentProfileReference('debug', reference).catch(() => {
      log.warn('[dot.li] profile debug presentation failed');
    });
  };
}
