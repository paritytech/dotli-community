// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A session window's settings. The network is the one its request names, already validated, for this window alone, and
// the rest is this origin's own. The window stores none of them, so a round never displaces the landing page's saved
// choice, and none of them is a reason to wipe or reload.

import { resolveSettings, type Network, type ParsedUrlSettings, type Settings } from '@dotli/config';

type Params = {
  /** The network the request names, already validated. */
  network: Network;
  /** This origin's stored settings. */
  local: Pick<Storage, 'getItem'>;
  sharedWorkerAvailable: boolean;
};

/**
 * Returns the window's settings, resolved with the request's `network` as the only setting it brings. Throws only as
 * `local.getItem` does.
 */
export function getWindowSettings({ network, local, sharedWorkerAvailable }: Params): Settings {
  // The request carries no other setting, so the rest falls through to this origin's.
  const url: ParsedUrlSettings = {
    network,
    backend: null,
    skipArchiveCache: null,
    skipCidCache: null,
    skipWorkerCache: null,
  };
  return resolveSettings({ local, shared: null, url, sharedWorkerAvailable }).settings;
}
