// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The registrable domains a site group is judged by. The Public Suffix List loads only once a site asks for a group,
// and once per instance.

import { createAsyncTaskPool } from '@dotli/shared';
import { parsePublicSuffixList, type PublicSuffixList } from './parsePublicSuffixList.js';

/** The registrable domains a site's group is judged by. */
export type SiteGroups = ReturnType<typeof createSiteGroups>;

type Params = {
  /** Where the Public Suffix List's text is fetched from. */
  listUrl: string;
  /** Fetches the list. Rejects when the network fails, which fails the load. */
  fetch: typeof fetch;
};

/** The registrable domains of the list at `listUrl`, fetched as text on the first call. */
export function createSiteGroups({ listUrl, fetch: fetchList }: Params) {
  // One load at a time, so calls made together share one, and each call after a failed load starts another.
  const loads = createAsyncTaskPool({ poolSize: 1 });
  let list: PublicSuffixList | null = null;

  async function loadList(): Promise<PublicSuffixList> {
    if (list !== null) {
      return list;
    }
    const response = await fetchList(listUrl);
    if (!response.ok) {
      throw new Error(`The Public Suffix List answered ${String(response.status)}`);
    }
    list = parsePublicSuffixList(await response.text());
    return list;
  }

  return {
    /**
     * The ASCII hostname's registrable domain, or null when it has none. Rejects when the list cannot be loaded, and the
     * next call loads it again.
     */
    async registrable(hostname: string): Promise<string | null> {
      const loaded = list ?? (await loads.call(loadList));
      return loaded.registrable(hostname);
    },
  };
}
