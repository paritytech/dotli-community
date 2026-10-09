// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { DEBUG } from '@dotli/config';
import { dotNsUrl } from '@dotli/shared';

export function parsePreviewTargetUrl(location: Pick<Location, 'pathname' | 'search'>): string | null {
  if (location.pathname !== '/__preview') {
    return null;
  }

  const raw = new URLSearchParams(location.search).get('url');
  if (raw === null || raw === '') {
    return null;
  }

  try {
    const target = new URL(raw);
    // Proxying a visitor's localhost into the trusted host origin is debug-only. Webcontainer preview
    // hosts are public https origins, so they are always allowed.
    const targetIsAllowedLocalhost = DEBUG && dotNsUrl.parseLocalhostUrl(target.toString()) !== null;
    const isWebContainer = target.protocol === 'https:' && dotNsUrl.isWebcontainerPreviewHost(target.hostname);

    if ((!targetIsAllowedLocalhost && !isWebContainer) || target.username || target.password) {
      return null;
    }

    return target.toString();
  } catch {
    return null;
  }
}
