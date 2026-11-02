// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ExecutableKind, ExecutableManifest, ManifestRecordResult } from './manifestTypes.js';
import { toManifestResult } from './toManifestResult.js';
import { parseExecutableManifest } from './validateExecutableManifest.js';

/** A `kind` that disagrees with the subname is invalid, so a worker cannot pose as the app. */
export function toExecutableManifestResult(
  raw: string | null,
  kind: ExecutableKind,
): ManifestRecordResult<ExecutableManifest> {
  const result = toManifestResult(raw, parseExecutableManifest);
  if (result.kind === 'ok' && result.value.kind !== kind) {
    return {
      kind: 'invalid',
      errors: [`executable manifest kind '${result.value.kind}' does not match its subname '${kind}'`],
      raw: result.raw,
    };
  }
  return result;
}
