// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one-time offer of the desktop app. Where the browser blocks storage, the offer reads as never dismissed and a
// dismissal lasts for this page only, so a blocked store never stops the page from starting.

import { DesktopIcon } from '@dotli/ui/icons';
import type { ShowNotification } from '@dotli/ui';
import type { SafeStorage } from '@dotli/shared';

const DISMISSED_KEY = 'desktop-banner-dismissed';
const PUBLIC_DOWNLOAD_URL = 'https://polkadot.com/get-started/polkadot-for-desktop';

export interface DesktopOfferDeps {
  /** This origin's localStorage, which never throws. */
  storage: Pick<SafeStorage, 'getItem' | 'setItem'>;
  notify: ShowNotification;
  /** The public download page when the build names none. */
  downloadUrl?: string | undefined;
}

/** Offers the desktop app unless the visitor dismissed the offer before. */
export function offerDesktopApp({ storage, notify, downloadUrl = PUBLIC_DOWNLOAD_URL }: DesktopOfferDeps): void {
  if (wasDismissed(storage)) {
    return;
  }
  notify({
    label: 'Get Polkadot Desktop',
    text: 'Full experience with native performance',
    deeplink: downloadUrl,
    icon: DesktopIcon,
    dismissMs: 0,
    browserNotification: false,
    onDismiss: () => {
      storage.setItem(DISMISSED_KEY, '1');
    },
  });
}

function wasDismissed(storage: DesktopOfferDeps['storage']): boolean {
  return storage.getItem(DISMISSED_KEY) !== null;
}
