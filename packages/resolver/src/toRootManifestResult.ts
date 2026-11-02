// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ManifestRecordResult, RootManifest } from './manifestTypes.js';
import { toManifestResult } from './toManifestResult.js';
import { parseRootManifest } from './validateRootManifest.js';

/** Maps a root manifest record's text to its result. */
export function toRootManifestResult(raw: string | null): ManifestRecordResult<RootManifest> {
  return toManifestResult(raw, parseRootManifest);
}
