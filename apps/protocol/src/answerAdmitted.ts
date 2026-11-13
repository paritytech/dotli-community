// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { SiteId } from '@dotli/config';
import { isSharedAuthSiteId } from '@dotli/protocol';
import { ok, type Failure, type ResultPayload } from '@dotli/transport';

import { InvalidInputError } from './invalidInputError.js';

/**
 * Answers with what `run` returns for the call's site once it checks. Rejects with an `InvalidInputError` when the site
 * does not check, and with what `run` throws.
 */
export async function answerAdmitted<T>(
  payload: { siteId: string },
  run: (site: SiteId) => T | Promise<T>,
): Promise<ResultPayload<T, Failure>> {
  if (!isSharedAuthSiteId(payload.siteId)) {
    throw new InvalidInputError(`Invalid siteId: ${String(payload.siteId)}`);
  }
  return ok(await run(payload.siteId));
}
