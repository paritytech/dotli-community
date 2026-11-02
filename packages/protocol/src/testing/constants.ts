// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProtocolFrameConfig } from '../frameTypes.js';

export const FRAME_ORIGIN = 'https://dot.li';

export const FRAME_CONFIG: ProtocolFrameConfig = {
  backend: 'smoldot-direct',
  network: 'paseo-next-v2',
  skipWorkerCache: false,
};

/** The host page's origin, as the frame's window knows it. */
export const HOST_ORIGIN = 'https://dot.li';
