// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Each network's stored copy of its signed stack and the light specs the light client accepted, so a start reads them
// without waiting on the network.

import type { Network } from '@dotli/config';
import { createCacheReporter } from './createCacheReporter.js';
import { pageIdb, type DotliIdb } from './db.js';
import { LIGHT_SPEC_STORE, STACK_STORE } from './schema.js';
import { unsafe_readStoredRecord } from './unsafe_readStoredRecord.js';
import { waitForIdbRequest, runIdbTransaction } from '@dotli/shared';

/** A network's signed stack, as stored for the next start. */
export type StoredStack = {
  network: Network;
  /** The stack's link, which carries the key the descriptor is signed with. */
  pointer: string;
  /** The signed descriptor's bytes, as served. */
  descriptor: Uint8Array;
  /** The descriptor's sequence, which a newer copy exceeds. */
  sequence: number;
};

/** Light spec bytes as served, by their `0x` SHA-256. */
export type StoredLightSpecs = ReadonlyMap<string, Uint8Array>;

type LightSpecRecord = {
  network: Network;
  specs: StoredLightSpecs;
};

type Params = {
  /** The database the copies live in. */
  idb?: DotliIdb;
};

// Module scope is the page, so each action's fault is captured once per page.
const reportStackFailure: (action: 'read' | 'write', error: unknown) => void = createCacheReporter({
  cache: 'stack',
  tag: '[dot.li stack]',
});
const reportLightSpecFailure: (action: 'read' | 'write', error: unknown) => void = createCacheReporter({
  cache: 'light_specs',
  tag: '[dot.li light-specs]',
});

/** The stack store over `idb`, the page's own by default. */
export function createStackStore({ idb = pageIdb }: Params = {}) {
  async function getStack(network: Network): Promise<StoredStack | null> {
    try {
      const db = await idb.connect();
      const record = unsafe_readStoredRecord<StoredStack | undefined>(
        await waitForIdbRequest(db.transaction(STACK_STORE, 'readonly').objectStore(STACK_STORE).get(network)),
      );
      return record ?? null;
    } catch (error) {
      reportStackFailure('read', error);
      return null;
    }
  }

  async function setStack(stack: StoredStack): Promise<void> {
    try {
      const db = await idb.connect();
      await runIdbTransaction({
        db,
        stores: STACK_STORE,
        mode: 'readwrite',
        body: transaction => {
          transaction.objectStore(STACK_STORE).put(stack);
        },
      });
    } catch (error) {
      reportStackFailure('write', error);
    }
  }

  async function getLightSpecs(network: Network): Promise<StoredLightSpecs> {
    try {
      const db = await idb.connect();
      const record = unsafe_readStoredRecord<LightSpecRecord | undefined>(
        await waitForIdbRequest(
          db.transaction(LIGHT_SPEC_STORE, 'readonly').objectStore(LIGHT_SPEC_STORE).get(network),
        ),
      );
      return record?.specs ?? new Map();
    } catch (error) {
      reportLightSpecFailure('read', error);
      return new Map();
    }
  }

  async function setLightSpecs(network: Network, specs: StoredLightSpecs): Promise<void> {
    const record: LightSpecRecord = { network, specs };
    try {
      const db = await idb.connect();
      await runIdbTransaction({
        db,
        stores: LIGHT_SPEC_STORE,
        mode: 'readwrite',
        body: transaction => {
          transaction.objectStore(LIGHT_SPEC_STORE).put(record);
        },
      });
    } catch (error) {
      reportLightSpecFailure('write', error);
    }
  }

  async function setStackAndLightSpecs(stack: StoredStack, specs: StoredLightSpecs): Promise<void> {
    const record: LightSpecRecord = { network: stack.network, specs };
    try {
      const db = await idb.connect();
      await runIdbTransaction({
        db,
        stores: [STACK_STORE, LIGHT_SPEC_STORE],
        mode: 'readwrite',
        body: transaction => {
          transaction.objectStore(STACK_STORE).put(stack);
          transaction.objectStore(LIGHT_SPEC_STORE).put(record);
        },
      });
    } catch (error) {
      reportStackFailure('write', error);
    }
  }

  return {
    /** `null` covers both a miss and a storage error, which is reported here. */
    getStack,
    /**
     * Replaces the network's copy and resolves once the write commits. A failure keeps the old copy and is reported
     * here.
     */
    setStack,
    /** Empty covers both a miss and a storage error, which is reported here. */
    getLightSpecs,
    /**
     * Replaces the network's whole set, so a spec left out is dropped. A failure keeps the old set and is reported here.
     */
    setLightSpecs,
    /**
     * Replaces the network's copy and its light specs in one write, and resolves once it commits. A failure keeps both
     * old records and is reported here.
     */
    setStackAndLightSpecs,
  };
}

export type StackStore = ReturnType<typeof createStackStore>;

/** The page's stack store. */
export const stackStore = createStackStore();
