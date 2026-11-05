// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChainPool } from '@dotli/chains';
import { protocolSchema, type ProtocolServing } from '@dotli/protocol';
import { ok } from '@dotli/transport';

type Params = {
  /** Where the frame serves the host. */
  serving: Pick<ProtocolServing, 'handleRequest'>;
  /** The frame's pool, paused on the host's word. */
  pool: Pick<ChainPool, 'pause' | 'resume'>;
};

/** Serves `frame.pause` on `pool`: `true` pauses it and `false` resumes it. Returns the stop. */
export function serveFramePause({ serving, pool }: Params): () => void {
  return serving.handleRequest(protocolSchema.sections.frame.pause, ({ paused }) => {
    if (paused) {
      pool.pause();
    } else {
      pool.resume();
    }
    return Promise.resolve(ok());
  });
}
