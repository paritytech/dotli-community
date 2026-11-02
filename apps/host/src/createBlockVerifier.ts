// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The verifier's chunk loads on the first block check. A failed load rejects the check that asked for it and the next
// check tries again, while only the first miss of the page is reported.

import { createLazyLoad } from '@dotli/shared';

type Verifier = {
  isBlockMatchingCid: (cid: string, bytes: Uint8Array) => boolean | Promise<boolean>;
};

type Params = {
  /** Loads the verifier's chunk. A rejected load is tried again by the next check. */
  load: () => Promise<Verifier>;
  /** Reports the page's first failed load. */
  report: (step: string, error: unknown) => void;
};

/**
 * Builds the relay's block check around a lazily loaded verifier. The check resolves whether `bytes` match `cid`, and
 * rejects with the verifier load's error.
 */
export function createBlockVerifier({ load, report }: Params): (cid: string, bytes: Uint8Array) => Promise<boolean> {
  const verifier = createLazyLoad({
    load,
    onFirstMiss(error) {
      report('block_verifier_load', error);
    },
  });
  return async (cid, bytes) => (await verifier()).isBlockMatchingCid(cid, bytes);
}
