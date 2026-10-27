// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { BuildSystemEventParams } from './buildSystemEvent.js';

/** A desktop viewport, in px. */
export const VIEWPORT = { width: 1024, height: 768 };

/** The host's boot step on smoldot with both caches in use. */
export const BOOT_STARTED: BuildSystemEventParams = {
  layer: 'boot',
  event: 'started',
  payload: { chainBackend: 'smoldot', skipCidCache: false, skipArchiveCache: false },
};
