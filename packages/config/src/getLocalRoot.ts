// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { isUnder } from './isUnder.js';
import { getTrustedLocalRoots } from './localRoots.js';

type Params = {
  /** Whether the roots a development build trusts apply. The page's own build by default. */
  dev?: boolean;
};

/**
 * The local root `hostname` is or sits under, or `null` for a host off every local root a build of kind `dev`
 * trusts.
 */
export function getLocalRoot(hostname: string, { dev = import.meta.env.DEV }: Params = {}): string | null {
  return getTrustedLocalRoots(dev).find(root => isUnder(hostname, root)) ?? null;
}
