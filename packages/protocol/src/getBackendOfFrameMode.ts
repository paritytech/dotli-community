// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { parseBackend, type Backend } from '@dotli/config';

/**
 * The word for each backend in the frame's URL, which the host writes and the frame reads back. `rpc` bridges chain
 * calls over trusted WSS JSON-RPC instead of smoldot.
 */
export const FRAME_MODES = {
  'smoldot-shared-worker': 'shared-worker',
  'smoldot-direct': 'direct',
  'rpc-gateway': 'rpc',
} as const satisfies Record<Backend, string>;

/** The backend a frame URL's `mode` names, or null for a word this build does not know. */
export function getBackendOfFrameMode(mode: string): Backend | null {
  return parseBackend(Object.entries(FRAME_MODES).find(([, word]) => word === mode)?.[0] ?? null);
}
