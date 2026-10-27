// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DotnsContracts } from '@dotli/config';
import type { Api } from './createRawApi.js';
import type { ExecutableKind, ExecutableManifest, ManifestResult } from './manifestTypes.js';
import { readManifestText } from './readManifestText.js';
import { computeNamehash } from './storageSlots.js';
import { toExecutableManifestResult } from './toExecutableManifestResult.js';

type Params = {
  api: Api;
  dotns: DotnsContracts;
  label: string;
  kind: ExecutableKind;
};

const EXECUTABLE_MANIFEST_KEY = 'executable';

/**
 * Reads the `kind` manifest on `<kind>.<label>.<tld>`. `unsupported` when the network has no text records. Rejects
 * with the storage read's error.
 */
export function readExecutableManifest({
  api,
  dotns,
  label,
  kind,
}: Params): Promise<ManifestResult<ExecutableManifest>> {
  return readManifestText({
    api,
    dotns,
    node: computeNamehash(`${kind}.${label}.${dotns.TLD}`),
    key: EXECUTABLE_MANIFEST_KEY,
    metricKind: kind,
    judge: raw => toExecutableManifestResult(raw, kind),
  });
}
