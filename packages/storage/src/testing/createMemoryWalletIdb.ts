// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { openIdb } from '@dotli/shared';
import { upgradeWalletDb, WALLET_DB_NAME, WALLET_DB_VERSION } from '../schema.js';
import { createMemoryIdbOf, type MemoryIdb, type MemoryIdbParams } from './createMemoryIdbOf.js';

/** A fresh in-memory wallet database, in place of the frame's own. */
export function createMemoryWalletIdb(params: MemoryIdbParams = {}): MemoryIdb {
  return createMemoryIdbOf({
    open: factory => openIdb({ factory, name: WALLET_DB_NAME, version: WALLET_DB_VERSION, upgrade: upgradeWalletDb }),
    ...params,
  });
}
