// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChainPoolControl } from '@dotli/chains';
import { protocolSchema, type ProtocolServing } from '@dotli/protocol';
import { ok } from '@dotli/transport';

type Params = {
  /** Where the frame serves the host. */
  serving: Pick<ProtocolServing, 'handleRequest'>;
  /** What the host's pause and resume reach in this context. */
  control: ChainPoolControl;
};

/** Serves `frame.pause` on `control`: `true` pauses it and `false` resumes it. Returns the stop. */
export function servePoolControl({ serving, control }: Params): () => void {
  return serving.handleRequest(protocolSchema.sections.frame.pause, ({ paused }) => {
    if (paused) {
      control.pause();
    } else {
      control.resume();
    }
    return ok();
  });
}
