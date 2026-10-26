// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The registrable domains a site group is judged by. The Public Suffix List loads only once a site asks for a group,
// and once per instance.

import { createAsyncTaskPool } from '@dotli/shared';
import { parsePublicSuffixList, type PublicSuffixList } from './public-suffix-list.js';

export type SiteGroups = {
  /**
   * The ASCII hostname's registrable domain, or null when it has none. Rejects when the list cannot be loaded, and the
   * next call loads it again.
   */
  registrable(hostname: string): Promise<string | null>;
};

/** The registrable domains of the list at `listUrl`, fetched as text on the first call. */
export function createSiteGroups(deps: { listUrl: string; fetch: typeof fetch }): SiteGroups {
  // One load at a time, so calls made together share one, and each call after a failed load starts another.
  const loads = createAsyncTaskPool({ poolSize: 1 });
  let list: PublicSuffixList | null = null;

  const load = async (): Promise<PublicSuffixList> => {
    if (list !== null) {
      return list;
    }
    const response = await deps.fetch(deps.listUrl);
    if (!response.ok) {
      throw new Error(`The Public Suffix List answered ${String(response.status)}`);
    }
    list = parsePublicSuffixList(await response.text());
    return list;
  };

  return {
    async registrable(hostname) {
      const loaded = list ?? (await loads.call(load));
      return loaded.registrable(hostname);
    },
  };
}
