// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A session window's settings. The network is the one its request names, already validated, for this window alone, and
// the rest is this origin's own. The window stores none of them, so a round never displaces the landing page's saved
// choice, and none of them is a reason to wipe or reload.

import { resolveSettings, type Network, type ParsedUrlSettings, type Settings } from '@dotli/config';

/** The window's settings, resolved with the request's validated `net` as the only setting it brings. */
export function windowSettings(
  net: Network,
  local: Pick<Storage, 'getItem'>,
  sharedWorkerAvailable: boolean,
): Settings {
  // The request carries no other setting, so the rest falls through to this origin's.
  const url: ParsedUrlSettings = {
    network: net,
    backend: null,
    skipArchiveCache: null,
    skipCidCache: null,
    skipWorkerCache: null,
  };
  return resolveSettings({ local, shared: null, url, sharedWorkerAvailable }).settings;
}
