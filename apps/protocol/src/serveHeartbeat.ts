// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { protocolSchema, type ProtocolServing } from '@dotli/protocol';
import { ok } from '@dotli/transport';

type Params = {
  /** Where the frame serves the host. */
  serving: Pick<ProtocolServing, 'handleRequest'>;
};

/**
 * Answers the host's `frame.heartbeat` at once, so the host can tell a frame that still answers from one that went
 * silent. Returns the stop.
 */
export function serveHeartbeat({ serving }: Params): () => void {
  return serving.handleRequest(protocolSchema.sections.frame.heartbeat, () => Promise.resolve(ok()));
}
