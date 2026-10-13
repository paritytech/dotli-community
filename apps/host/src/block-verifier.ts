// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The verifier's chunk loads on the first block check. One pool owns that load: a failed load rejects the check that
// asked for it and the next check tries again, while only the first miss of the page is reported.

import { createAsyncTaskPool } from '@dotli/shared';

interface Verifier {
  blockMatchesCid: (cid: string, bytes: Uint8Array) => boolean | Promise<boolean>;
}

export interface BlockVerifierDeps {
  load: () => Promise<Verifier>;
  report: (step: string, err: unknown) => void;
}

/** Builds the relay's block check around a lazily loaded verifier. */
export function createBlockVerifier({
  load,
  report,
}: BlockVerifierDeps): (cid: string, bytes: Uint8Array) => Promise<boolean> {
  const loads = createAsyncTaskPool({ poolSize: 1 });
  let verifier: Verifier | undefined;
  let reported = false;
  const loaded = async (): Promise<Verifier> => {
    if (verifier !== undefined) {
      return verifier;
    }
    try {
      verifier = await load();
      return verifier;
    } catch (err: unknown) {
      if (!reported) {
        reported = true;
        report('block_verifier_load', err);
      }
      throw err;
    }
  };
  return async (cid, bytes) => (await loads.call(loaded, { pool: 'load' })).blockMatchesCid(cid, bytes);
}
