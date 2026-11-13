// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The core's slots in this origin's localStorage, every slot but its session. Secret slots are encrypted at rest under a
// random key kept in IndexedDB.

import { encodeCoreStorageKey } from '@parity/truapi-host';
import type { CoreStorageKey } from '@parity/truapi-host';
import { createReporter, defineCount } from '@dotli/metrics';
import { createAsyncTaskPool, fromHex, waitForIdbRequest, runIdbTransaction, openIdb, toHex } from '@dotli/shared';

const storageReport = createReporter({ flow: 'storage' });

/**
 * The at-rest key of the core's secret slots. Tagged `outcome` (error) and `reason`: `ephemeral_key` when IndexedDB
 * cannot keep it, so this session's secrets will not decrypt after a reload, or `undecryptable` for a slot dropped
 * because it does not decrypt.
 */
const coreStorageSecretMetric = defineCount<'error'>('core_storage.secret');

/**
 * A stored core value that could not be decoded, which then reads as absent. Tagged `outcome` (error) and `reason`
 * (`corrupt`).
 */
const coreStorageReadMetric = defineCount<'error'>('core_storage.read');

/** A core slot of this origin's localStorage: every slot but the session, which lives in the shared store. */
export type LocalCoreKey = Exclude<CoreStorageKey, { tag: 'AuthSession' }>;

type LocalCoreSlotsParams = {
  /** This origin's slots. Reached on every call, as the page's localStorage throws where the browser blocks it. */
  local?: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** Where the at-rest key is kept. */
  keyDb?: () => IDBFactory;
};

const CORE_LOCAL_STORAGE_PREFIX = 'dotli:core:';

// Marks a secret slot's value as ciphertext. A value without it does not decrypt and is dropped.
const ENCRYPTED_VALUE_PREFIX = 'enc1:';

// A fresh nonce per write, since GCM security collapses if a key and nonce pair is ever reused.
const CORE_SECRET_NONCE_LENGTH = 12;

const KEY_DB_NAME = 'dotli-core';
const KEY_DB_STORE = 'keys';
const CORE_SECRET_KEY_ID = 'allowance-keys';

/** The core's local slots. `read` and `write` reject and `clear` throws where localStorage throws. */
export function createLocalCoreSlots({
  local = () => localStorage,
  keyDb = () => indexedDB,
}: LocalCoreSlotsParams = {}) {
  // One load at a time, and every later call finds the key already loaded.
  const secretKeyLoads = createAsyncTaskPool({ poolSize: 1 });
  let secretKey: CryptoKey | null = null;

  /**
   * A random non-extractable key in IndexedDB, since one derived from bundle data would be computable by anyone.
   * Without IndexedDB it is session-ephemeral, and its values are dropped after a reload.
   */
  function getSecretKey(): Promise<CryptoKey> {
    return secretKeyLoads.call(async () => {
      secretKey ??= await loadOrCreateSecretKey(keyDb).catch((error: unknown) => {
        // A browser that refuses IndexedDB, as a private window may, cannot keep the key. Secrets written now will
        // not decrypt after a reload, which is the environment's limit, not a fault.
        storageReport.expected(error, {
          step: 'core_secret_key',
          metric: coreStorageSecretMetric,
          reason: 'ephemeral_key',
          message: '[dot.li] falling back to a session-ephemeral core-secret storage key:',
        });
        return generateSecretKey();
      });
      return secretKey;
    });
  }

  async function encode(key: LocalCoreKey, value: Uint8Array): Promise<string> {
    if (!isSecretMaterialSlot(key)) {
      return toHex(value);
    }
    const nonce = crypto.getRandomValues(new Uint8Array(CORE_SECRET_NONCE_LENGTH));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await getSecretKey(), new Uint8Array(value)),
    );
    const stored = new Uint8Array(nonce.length + ciphertext.length);
    stored.set(nonce);
    stored.set(ciphertext, nonce.length);
    return ENCRYPTED_VALUE_PREFIX + toHex(stored);
  }

  async function decode(key: LocalCoreKey, raw: string): Promise<Uint8Array | undefined> {
    if (!isSecretMaterialSlot(key)) {
      return decodeStoredBytes(raw, `core storage ${key.tag}`);
    }
    if (!raw.startsWith(ENCRYPTED_VALUE_PREFIX)) {
      return dropUndecryptable(key, new Error(`core storage ${key.tag} is not encrypted`));
    }
    const bytes = decodeStoredBytes(raw.slice(ENCRYPTED_VALUE_PREFIX.length), `core storage ${key.tag}`);
    if (bytes === undefined) {
      return undefined;
    }
    try {
      return new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: bytes.slice(0, CORE_SECRET_NONCE_LENGTH) },
          await getSecretKey(),
          bytes.slice(CORE_SECRET_NONCE_LENGTH),
        ),
      );
    } catch (error) {
      // Written under a key we no longer hold, or corrupt. Returning the raw bytes would hand
      // ciphertext to the core as key material.
      return dropUndecryptable(key, error);
    }
  }

  function dropUndecryptable(key: LocalCoreKey, error: unknown): undefined {
    storageReport.expected(error, {
      step: 'core_secret_decrypt',
      metric: coreStorageSecretMetric,
      reason: 'undecryptable',
      message: `[dot.li] dropping undecryptable core storage ${key.tag}:`,
    });
    local().removeItem(getSlotName(key));
    return undefined;
  }

  return {
    /** The slot's value, or undefined for none and for one that does not decode or decrypt, which is dropped. */
    async read(key: LocalCoreKey): Promise<Uint8Array | undefined> {
      const raw = local().getItem(getSlotName(key));
      return raw === null ? undefined : await decode(key, raw);
    },
    /** Stores `value` in the slot, encrypted when the slot holds secret material. */
    async write(key: LocalCoreKey, value: Uint8Array): Promise<void> {
      local().setItem(getSlotName(key), await encode(key, value));
    },
    clear(key: LocalCoreKey): void {
      local().removeItem(getSlotName(key));
    },
  };
}

/** The bytes of `raw` hex, or undefined for a value that is not hex, which is reported as corrupt `description`. */
export function decodeStoredBytes(raw: string, description: string): Uint8Array | undefined {
  try {
    return fromHex(raw);
  } catch (error) {
    storageReport.expected(error, {
      step: 'core_decode',
      metric: coreStorageReadMetric,
      reason: 'corrupt',
      message: `[dot.li] ignoring corrupt ${description}:`,
    });
    return undefined;
  }
}

function getSlotName(key: LocalCoreKey): string {
  switch (key.tag) {
    case 'PairingDeviceIdentity':
      return `${CORE_LOCAL_STORAGE_PREFIX}pairing-device-identity`;
    case 'PermissionAuthorization':
      return `${CORE_LOCAL_STORAGE_PREFIX}permission:${formatHexNoPrefix(encodeCoreStorageKey(key))}`;
    case 'AllowanceKeys':
      return `${CORE_LOCAL_STORAGE_PREFIX}allowance-keys:${key.value.sessionId}`;
    case 'AutoSigningKey':
      return `${CORE_LOCAL_STORAGE_PREFIX}auto-signing:${formatHexNoPrefix(encodeCoreStorageKey(key))}`;
    // One slot for the active pairing, unlike the per-product `AutoSigningKey`.
    case 'AutoSigningKeys':
      return `${CORE_LOCAL_STORAGE_PREFIX}auto-signing-keys`;
    // Keyed by root public key so several rings coexist. The snapshot is public, so not secret material.
    case 'RingVrfRegistry':
      return `${CORE_LOCAL_STORAGE_PREFIX}ring-vrf-registry:${formatHexNoPrefix(encodeCoreStorageKey(key))}`;
    case 'StatementRenewalTargets':
      return `${CORE_LOCAL_STORAGE_PREFIX}statement-renewal-targets`;
    case 'LastProcessedPairingStatement':
      return `${CORE_LOCAL_STORAGE_PREFIX}last-processed-pairing-statement`;
    // Peers address this device by the public counterpart, so the slot must not move with the session.
    case 'DeviceEncryptionKey':
      return `${CORE_LOCAL_STORAGE_PREFIX}device-encryption-key`;
    // Keyed by session too, since pairing again re-asks the Account Holder.
    case 'ProductSubtree':
      return `${CORE_LOCAL_STORAGE_PREFIX}product-subtree:${formatHexNoPrefix(encodeCoreStorageKey(key))}`;
    // The ledger bounds replays for one wallet and peer pair, so the whole triple keys the slot.
    case 'SsoResponderRequestLedger':
      return `${CORE_LOCAL_STORAGE_PREFIX}sso-responder-ledger:${formatHexNoPrefix(encodeCoreStorageKey(key))}`;
    // Per product, so one product's revoked grant expires without touching the others.
    case 'ProductManifest':
      return `${CORE_LOCAL_STORAGE_PREFIX}product-manifest:${key.value.productLabel}`;
  }
}

function isSecretMaterialSlot(key: LocalCoreKey): boolean {
  switch (key.tag) {
    case 'AllowanceKeys':
    case 'AutoSigningKey':
    case 'AutoSigningKeys':
    case 'DeviceEncryptionKey':
      return true;
    case 'PairingDeviceIdentity':
    case 'PermissionAuthorization':
    case 'RingVrfRegistry':
    case 'StatementRenewalTargets':
    case 'LastProcessedPairingStatement':
    case 'ProductSubtree':
    case 'SsoResponderRequestLedger':
    case 'ProductManifest':
      return false;
  }
}

function generateSecretKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function loadOrCreateSecretKey(keyDb: () => IDBFactory): Promise<CryptoKey> {
  const database = await openKeyDatabase(keyDb());
  try {
    const existing = await readStoredSecretKey(database);
    if (existing !== undefined) {
      return existing;
    }
    const key = await generateSecretKey();
    try {
      await addStoredSecretKey(database, key);
      return key;
    } catch (error) {
      // add() rejects when another tab won the race, so adopt its key rather than split the install.
      const winner = await readStoredSecretKey(database);
      if (winner !== undefined) {
        return winner;
      }
      throw error;
    }
  } finally {
    database.close();
  }
}

function openKeyDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return openIdb({
    factory,
    name: KEY_DB_NAME,
    version: 1,
    upgrade: database => {
      database.createObjectStore(KEY_DB_STORE);
    },
  });
}

async function readStoredSecretKey(database: IDBDatabase): Promise<CryptoKey | undefined> {
  const value: unknown = await waitForIdbRequest(
    database.transaction(KEY_DB_STORE).objectStore(KEY_DB_STORE).get(CORE_SECRET_KEY_ID),
  );
  return isCryptoKey(value) ? value : undefined;
}

/** Rejects when another tab added the key first, and on a commit-time abort such as a full quota. */
function addStoredSecretKey(database: IDBDatabase, key: CryptoKey): Promise<void> {
  return runIdbTransaction({
    db: database,
    stores: KEY_DB_STORE,
    mode: 'readwrite',
    body: transaction => {
      transaction.objectStore(KEY_DB_STORE).add(key, CORE_SECRET_KEY_ID);
    },
  });
}

/** `instanceof CryptoKey` is unreliable across realms and the global is missing under happy-dom. */
function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof value === 'object' && value !== null && (value as CryptoKey).type === 'secret';
}

function formatHexNoPrefix(bytes: Uint8Array): string {
  return toHex(bytes).slice(2);
}
