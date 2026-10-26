// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The verifier's chunk loads on the first block check. A failed load rejects the check that asked for it and the next
// check tries again, while only the first miss of the page is reported.

import { createLazyLoad } from '@dotli/shared';

type Verifier = {
  blockMatchesCid: (cid: string, bytes: Uint8Array) => boolean | Promise<boolean>;
};

export type BlockVerifierDeps = {
  load: () => Promise<Verifier>;
  report: (step: string, err: unknown) => void;
};

/** Builds the relay's block check around a lazily loaded verifier. */
export function createBlockVerifier({
  load,
  report,
}: BlockVerifierDeps): (cid: string, bytes: Uint8Array) => Promise<boolean> {
  const verifier = createLazyLoad(load, {
    onFirstMiss: err => {
      report('block_verifier_load', err);
    },
  });
  return async (cid, bytes) => (await verifier()).blockMatchesCid(cid, bytes);
}
