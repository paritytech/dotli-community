// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imports no Solid, so it runs under Node. Returns plain data that callers render as JSX text, which escapes it.

import { getEventLabel } from './getEventLabel.js';
import type { StoredSystemEvent } from './storedEvent.js';
import { summariseSystemEvent } from './summariseSystemEvent.js';

export type SystemRowData = {
  layer: StoredSystemEvent['layer'];
  source: StoredSystemEvent['source'];
  flowId: string;
  eventText: string;
  summary: string;
};

/** What a host event's row shows. Never throws. */
export function toSystemRowData(event: StoredSystemEvent): SystemRowData {
  return {
    layer: event.layer,
    source: event.source,
    flowId: event.flowId,
    eventText: getEventLabel(event),
    summary: summariseSystemEvent(event),
  };
}
