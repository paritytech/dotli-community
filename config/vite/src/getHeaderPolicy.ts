// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { ASSETS_PREFIX, isSessionPath, type Route } from './siteRoutes.ts';

/**
 * `isolated` is a cross-origin isolated or embeddable page. `worker-coep` is a bare-host asset, whose worker script
 * must carry COEP itself or the isolated /__preview page cannot start it. `unframed` is a session window, which no page
 * may frame and which sends no opener policy, since that would cut its link to the page that opened it.
 */
export type HeaderPolicy = 'isolated' | 'worker-coep' | 'unframed' | 'plain';

/**
 * Returns the header policy of `pathname` on the route. Never throws. COEP on the host's other documents would block
 * the localhost proxy iframe, so only /__preview is isolated there.
 */
export function getHeaderPolicy(route: Route, pathname: string): HeaderPolicy {
  if (route.site !== 'host' || (route.bare && pathname === '/__preview')) {
    return 'isolated';
  }
  if (isSessionPath(route, pathname)) {
    return 'unframed';
  }
  return route.bare && pathname.startsWith(ASSETS_PREFIX) ? 'worker-coep' : 'plain';
}
