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
    // The wire carries only the fields every sandbox release sends. The panel's union names each event.
    emit(event as DotliDebugEvent);
  });
}
