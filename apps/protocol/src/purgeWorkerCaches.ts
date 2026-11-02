// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Dropping what warm-starts the chains. The frame shares its origin with the landing page, so it deletes its own chain
// databases by name and nothing else.

import { SMOLDOT_DB_NAME } from '@dotli/chains';
import { deleteIdb } from '@dotli/shared';

const CHAIN_DATABASES: readonly string[] = [SMOLDOT_DB_NAME];

/**
 * Deletes the chain databases and resolves their names. Rejects when one stays blocked or fails, so smoldot never
 * boots against it.
 */
export async function purgeWorkerCaches(factory: Pick<IDBFactory, 'deleteDatabase'>): Promise<readonly string[]> {
  await Promise.all(CHAIN_DATABASES.map(name => deleteIdb(factory, name)));
  return CHAIN_DATABASES;
}
