// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Records what the protocol frame tells the host page. A page runs this script in every frame it builds, so it
// records, and defines its global, only in the host page's top window, where the host listens.

import { protocolSchema } from '@dotli/protocol';
import { recordMessage, type RecordedWireMessage } from '@dotli/transport/testing';
import type {} from '../helpers/wire-recorder.js';

const PROTOCOL_HOSTNAME = 'host.localhost';

if (window.top === window && location.hostname !== PROTOCOL_HOSTNAME) {
  // The preview server serves every origin on the one port.
  const protocolOrigin = `${location.protocol}//${PROTOCOL_HOSTNAME}:${location.port}`;
  const seen: RecordedWireMessage[] = [];
  window.__dotliProtocolMessages = seen;
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.origin !== protocolOrigin || !(event.data instanceof ArrayBuffer)) {
      return;
    }
    const recorded = recordMessage(protocolSchema, event.data);
    // The light client's own traffic, which no test reads, would dwarf the rest and slow every wait that scans it.
    if (recorded !== null && recorded.section !== 'chain') {
      seen.push(recorded);
    }
  });
}
