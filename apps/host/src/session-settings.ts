// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in window's settings. The network is the opener's, for this window alone, and the rest is this origin's own.
// The window stores none of them, so a round never displaces the landing page's saved choice, and none of them is a
// reason to wipe or reload, which would end the round.

import { parseSettingsFromSearch, resolveSettings, type Settings } from '@dotli/config';

/**
 * The window's settings, resolved with `net` as the link's only setting. Reads `net` and never
 * `network`, the landing page's parameter, since an old worker can send this URL to the landing page with its query
 * kept.
 */
export function windowSettings(
  search: string,
  local: Pick<Storage, 'getItem'>,
  sharedWorkerAvailable: boolean,
): Settings {
  const net = new URLSearchParams(search).get('net');
  const url = parseSettingsFromSearch(new URLSearchParams(net === null ? {} : { network: net }));
  return resolveSettings({ local, shared: null, url, sharedWorkerAvailable }).settings;
}
