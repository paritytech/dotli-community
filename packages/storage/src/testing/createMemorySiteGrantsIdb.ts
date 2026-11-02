// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { openIdb } from '@dotli/shared';
import { SITE_GRANTS_DB_NAME, SITE_GRANTS_DB_VERSION, upgradeSiteGrantsDb } from '../schema.js';
import { createMemoryIdbOf, type MemoryIdb, type MemoryIdbParams } from './createMemoryIdbOf.js';

/** A fresh in-memory site grants database, in place of the session windows' own. */
export function createMemorySiteGrantsIdb(params: MemoryIdbParams = {}): MemoryIdb {
  return createMemoryIdbOf({
    open: factory =>
      openIdb({ factory, name: SITE_GRANTS_DB_NAME, version: SITE_GRANTS_DB_VERSION, upgrade: upgradeSiteGrantsDb }),
    ...params,
  });
}
