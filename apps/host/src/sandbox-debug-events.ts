// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Relays the sandbox's debug events to the host's debug bus, since the sandbox origin cannot reach the bus itself.

import type { SandboxChannel } from '@dotli/sandbox-wire';
import type { DotliDebugEvent } from '@dotli/truapi-debug';

/** Returns the unsubscribe. */
export function listenForSandboxDebugEvents(
  channel: SandboxChannel,
  emit: (event: DotliDebugEvent) => void,
): () => void {
  return channel.on('dotli:debug-event', ({ event }) => {
    try {
      // The wire carries only the fields every sandbox release sends. The panel's union names each event.
      emit(event as DotliDebugEvent);
      // eslint-disable-next-line no-restricted-syntax -- best-effort forwarder. A malformed event from the sandbox must never break the host.
    } catch {
      /* ignore: a malformed event shouldn't kill the host */
    }
  });
}
