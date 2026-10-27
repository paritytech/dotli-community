// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DotnsContracts } from '@dotli/config';
import type { Api } from './createRawApi.js';
import type { ManifestResult, RootManifest } from './manifestTypes.js';
import { readManifestText } from './readManifestText.js';
import { computeNamehash } from './storageSlots.js';
import { toRootManifestResult } from './toRootManifestResult.js';

type Params = {
  api: Api;
  dotns: DotnsContracts;
  label: string;
};

const ROOT_MANIFEST_KEY = 'manifest';

/**
 * Reads the root manifest on `<label>.<tld>`. `unsupported` when the network has no text records, so loading falls
 * back to the contenthash alone. Rejects with the storage read's error.
 */
export function readRootManifest({ api, dotns, label }: Params): Promise<ManifestResult<RootManifest>> {
  return readManifestText({
    api,
    dotns,
    node: computeNamehash(`${label}.${dotns.TLD}`),
    key: ROOT_MANIFEST_KEY,
    metricKind: 'root',
    judge: toRootManifestResult,
  });
}
