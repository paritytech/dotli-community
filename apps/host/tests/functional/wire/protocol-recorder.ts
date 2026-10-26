// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Records what the protocol frame tells the host page. A page runs this script in every frame it builds, so it
// records, and defines its global, only in the top window, where the host listens.

import { protocolSchema } from '@dotli/protocol';
import { recordMessage, type RecordedWireMessage } from '@dotli/transport/testing';
import type {} from '../helpers/wire-recorder.js';

if (window.top === window) {
  // The frame lives on the root origin, which the preview server serves on the page's own port.
  const protocolOrigin = `${location.protocol}//localhost:${location.port}`;
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
