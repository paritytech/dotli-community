// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { asProductId } from '@parity/truapi';
import type { CoreStorageKey } from '@parity/truapi-host';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';
import { noop, openIdb, waitForIdbRequest } from '@dotli/shared';
import { createMemoryStorage, must } from '@dotli/shared/testing';
import { createLocalCoreSlots, type LocalCoreKey } from './createLocalCoreSlots.js';

let local: Storage;
let keyDb: IDBFactory;
let slots: ReturnType<typeof createLocalCoreSlots>;

/** Records this test's counts and reports, for the tests that read what the slots report. */
function bindReports() {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  return { counted: metrics.counted, reports: recordReports({ onFinished: onTestFinished }) };
}

describe('local core slots', () => {
  beforeEach(() => {
    local = createMemoryStorage();
    keyDb = new IDBFactory();
    slots = createLocalCoreSlots({ local: () => local, keyDb: () => keyDb });
  });

  it.each<{
    label: string;
    key: LocalCoreKey;
    bytes: number[];
    slot: RegExp;
    hidden: string[];
    stored: unknown;
  }>([
    {
      label: 'a permission authorization from a typed core key, and it round-trips through an opaque slot',
      key: {
        tag: 'PermissionAuthorization',
        value: {
          scope: 'My App',
          request: { tag: 'Device', value: 'OpenUrl' },
        },
      },
      bytes: [4],
      slot: /^dotli:core:permission:[0-9a-f]+$/,
      hidden: ['open-url'],
      stored: '0x04',
    },
    {
      label: 'allowance keys, and they are stored encrypted and read back',
      key: { tag: 'AllowanceKeys', value: { sessionId: 'session-1' } },
      bytes: [1, 2, 3, 4],
      slot: /^dotli:core:allowance-keys:session-1$/,
      hidden: [],
      stored: expect.not.stringMatching(/^0x01020304$/),
    },
    {
      label: 'a product auto-signing key, and it is stored encrypted in an opaque slot',
      key: { tag: 'AutoSigningKey', value: { productId: asProductId('truapi-playground.dot') } },
      bytes: [5, 6, 7, 8],
      slot: /^dotli:core:auto-signing:[0-9a-f]+$/,
      hidden: ['truapi-playground.dot'],
      stored: expect.stringMatching(/^enc1:0x/),
    },
    {
      label: 'the device encryption secret, and it is stored encrypted in a stable install-wide slot',
      key: { tag: 'DeviceEncryptionKey' },
      bytes: [9, 10, 11, 12],
      // Peers address this device by the public counterpart, so the slot name
      // must not move with the session: a fresh name would orphan them.
      slot: /^dotli:core:device-encryption-key$/,
      hidden: [],
      stored: expect.stringMatching(/^enc1:0x/),
    },
  ])('As a dotli integrator, I write $label', async ({ key, bytes, slot, hidden, stored }) => {
    // When
    await slots.write(key, new Uint8Array(bytes));
    const readBack = await slots.read(key);

    // Then
    expect(local.length).toBe(1);
    const storageKey = local.key(0);
    expect(storageKey).toMatch(slot);
    expect(hidden.filter(label => storageKey?.includes(label) === true)).toEqual([]);
    expect(local.getItem(storageKey ?? '')).toEqual(stored);
    expect(Array.from(readBack ?? [])).toEqual(bytes);

    // When
    slots.clear(key);
    const afterClear = await slots.read(key);

    // Then
    expect(afterClear).toBeUndefined();
  });

  it('As a dotli integrator, I write product subtree keys for two sessions and each is stored per session in an opaque plaintext slot', async () => {
    // Given
    const key = {
      tag: 'ProductSubtree',
      value: {
        sessionId: 'session-1',
        productId: asProductId('truapi-playground.dot'),
      },
    } satisfies CoreStorageKey;
    const otherSession = {
      tag: 'ProductSubtree',
      value: {
        sessionId: 'session-2',
        productId: asProductId('truapi-playground.dot'),
      },
    } satisfies CoreStorageKey;

    // When
    await slots.write(key, new Uint8Array([13]));
    await slots.write(otherSession, new Uint8Array([14]));
    const readBack = await slots.read(key);
    const otherReadBack = await slots.read(otherSession);

    // Then
    // The slot holds a public key, so it is stored in the clear, but the
    // product it belongs to stays out of the visible storage key.
    expect(local.length).toBe(2);
    for (const index of [0, 1]) {
      const storageKey = local.key(index);
      expect(storageKey).toMatch(/^dotli:core:product-subtree:[0-9a-f]+$/);
      expect(storageKey).not.toContain('truapi-playground.dot');
      expect(local.getItem(storageKey ?? '')).toMatch(/^0x/);
    }
    // Pairing again answers afresh, so one session's answer must not be read
    // back for another.
    expect(Array.from(readBack ?? [])).toEqual([13]);
    expect(Array.from(otherReadBack ?? [])).toEqual([14]);

    // When
    slots.clear(key);
    const afterClear = await slots.read(key);
    const otherAfterClear = await slots.read(otherSession);

    // Then
    expect(afterClear).toBeUndefined();
    expect(Array.from(otherAfterClear ?? [])).toEqual([14]);
  });

  it('As a dotli integrator, I write the SSO responder replay ledger for two peers and each peer gets its own slot', async () => {
    // Given
    const key = {
      tag: 'SsoResponderRequestLedger',
      value: {
        rootPublicKey: new Uint8Array(32).fill(1),
        peerStatementAccountId: new Uint8Array(32).fill(2),
        peerEncryptionPublicKey: new Uint8Array(32).fill(3),
      },
    } satisfies CoreStorageKey;
    const otherPeer = {
      tag: 'SsoResponderRequestLedger',
      value: {
        rootPublicKey: new Uint8Array(32).fill(1),
        peerStatementAccountId: new Uint8Array(32).fill(2),
        peerEncryptionPublicKey: new Uint8Array(32).fill(4),
      },
    } satisfies CoreStorageKey;

    // When
    await slots.write(key, new Uint8Array([21]));
    await slots.write(otherPeer, new Uint8Array([22]));
    const readBack = await slots.read(key);
    const otherReadBack = await slots.read(otherPeer);

    // Then
    // Core-owned replay state, not key material, so it is stored like the
    // ring registry snapshot rather than under at-rest encryption.
    expect(local.length).toBe(2);
    for (const index of [0, 1]) {
      const storageKey = local.key(index);
      expect(storageKey).toMatch(/^dotli:core:sso-responder-ledger:[0-9a-f]+$/);
      expect(local.getItem(storageKey ?? '')).toMatch(/^0x/);
    }
    // The ledger bounds replays for one peer, so two peers of the same wallet
    // must never share a slot.
    expect(Array.from(readBack ?? [])).toEqual([21]);
    expect(Array.from(otherReadBack ?? [])).toEqual([22]);

    // When
    slots.clear(key);
    const afterClear = await slots.read(key);
    const otherAfterClear = await slots.read(otherPeer);

    // Then
    expect(afterClear).toBeUndefined();
    expect(Array.from(otherAfterClear ?? [])).toEqual([22]);
  });

  it('As a dotli integrator, I write the same allowance keys twice and no nonce is reused', async () => {
    // Given
    const key = {
      tag: 'AllowanceKeys',
      value: { sessionId: 'session-1' },
    } satisfies CoreStorageKey;
    const storageKey = 'dotli:core:allowance-keys:session-1';

    // When: the same plaintext is written twice
    await slots.write(key, new Uint8Array([1, 2, 3, 4]));
    const first = local.getItem(storageKey);
    await slots.write(key, new Uint8Array([1, 2, 3, 4]));
    const second = local.getItem(storageKey);
    const readBack = await slots.read(key);

    // Then: the ciphertexts differ (fresh nonce per write) and still decrypt
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(Array.from(readBack ?? [])).toEqual([1, 2, 3, 4]);
  });

  it('As a dotli integrator, I write allowance keys and they are encrypted under a non-extractable per-install key', async () => {
    // Given
    const key = {
      tag: 'AllowanceKeys',
      value: { sessionId: 'session-1' },
    } satisfies CoreStorageKey;

    // When
    await slots.write(key, new Uint8Array([1, 2, 3, 4]));
    const stored = await readStoredAllowanceKey(keyDb);
    const exported = crypto.subtle.exportKey('raw', must(stored, 'the stored key'));

    // Then: the encryption key is a random per-install CryptoKey persisted in IndexedDB whose material can never be
    // exported, not something derivable from public bundle data.
    expect(stored?.type).toBe('secret');
    expect(stored?.extractable).toBe(false);
    await expect(exported).rejects.toThrow();
  });

  it('As a dotli integrator, I read an allowance slot that holds plain bytes and it is dropped as undecryptable', async () => {
    // Given a secret slot whose value is not encrypted
    const { counted } = bindReports();
    const key = { tag: 'AllowanceKeys', value: { sessionId: 'plain' } } satisfies CoreStorageKey;
    const storageKey = 'dotli:core:allowance-keys:plain';
    local.setItem(storageKey, '0x01020304');

    // When
    const bytes = await slots.read(key);

    // Then: the plain bytes are never handed to the core as key material
    expect(bytes).toBeUndefined();
    expect(local.getItem(storageKey)).toBeNull();
    expect(counted('core_storage.secret')).toEqual([{ outcome: 'error', reason: 'undecryptable' }]);
  });

  it('As a dotli integrator, I read corrupt persisted core bytes and get a cache miss', async () => {
    // Given
    const { counted, reports } = bindReports();
    const key = {
      tag: 'AllowanceKeys',
      value: { sessionId: 'corrupt' },
    } satisfies CoreStorageKey;
    local.setItem('dotli:core:allowance-keys:corrupt', 'enc1:not-hex');

    // When
    const stored = slots.read(key);

    // Then
    await expect(stored).resolves.toBeUndefined();
    expect(counted('core_storage.read')).toEqual([{ outcome: 'error', reason: 'corrupt' }]);
    expect(reports.expected).toMatchObject([{ step: 'core_decode' }]);
  });

  it('As an operator, I see a browser that cannot keep the at-rest key recorded once and the session still round-trips its secrets', async () => {
    // Given a key store the browser refuses
    const { counted, reports } = bindReports();
    const refusing = createLocalCoreSlots({
      local: () => local,
      keyDb() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    const key = { tag: 'AllowanceKeys', value: { sessionId: 'session-1' } } satisfies CoreStorageKey;

    // When
    await refusing.write(key, new Uint8Array([1, 2, 3, 4]));
    const readBack = await refusing.read(key);

    // Then
    expect(Array.from(readBack ?? [])).toEqual([1, 2, 3, 4]);
    expect(reports.expected).toMatchObject([{ step: 'core_secret_key' }]);
    expect(reports.expected[0]?.error).toBeInstanceOf(DOMException);
    expect(counted('core_storage.secret')).toEqual([{ outcome: 'error', reason: 'ephemeral_key' }]);
  });

  it('As an operator, I read a secret slot that no longer decrypts and it is dropped instead of returning ciphertext, recorded and counted', async () => {
    // Given an encrypted slot whose ciphertext no longer authenticates, the same shape as a key lost to an IndexedDB wipe
    // or tampered bytes
    const { counted, reports } = bindReports();
    const key = { tag: 'AllowanceKeys', value: { sessionId: 'session-1' } } satisfies CoreStorageKey;
    const storageKey = 'dotli:core:allowance-keys:session-1';
    await slots.write(key, new Uint8Array([1, 2, 3, 4]));
    const stored = local.getItem(storageKey) ?? '';
    local.setItem(storageKey, stored.slice(0, -2) + (stored.endsWith('00') ? 'ff' : '00'));

    // When
    const bytes = await slots.read(key);

    // Then ciphertext is never handed back as key material, and the dead slot is removed
    expect(bytes).toBeUndefined();
    expect(local.getItem(storageKey)).toBeNull();
    expect(reports.expected).toMatchObject([{ step: 'core_secret_decrypt' }]);
    expect(counted('core_storage.secret')).toEqual([{ outcome: 'error', reason: 'undecryptable' }]);
  });
});

/** The slots' at-rest key in their IndexedDB key store. */
async function readStoredAllowanceKey(factory: IDBFactory): Promise<CryptoKey | undefined> {
  const database = await openIdb({ factory, name: 'dotli-core', version: 1, upgrade: noop });
  try {
    // IndexedDB types a stored value as any, and this store holds only CryptoKey values.
    return (await waitForIdbRequest(database.transaction('keys').objectStore('keys').get('allowance-keys'))) as
      CryptoKey | undefined;
  } finally {
    database.close();
  }
}
