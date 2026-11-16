// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The one-time offer of the desktop app. Where the browser blocks storage, the offer reads as never dismissed and a
// dismissal lasts for this page only, so a blocked store never stops the page from starting.

import { DesktopIcon } from '@dotli/ui/icons';
import type { ShowNotification } from '@dotli/ui';
import type { SafeStorage } from '@dotli/shared';

type Params = {
  /** This origin's localStorage, which never throws. */
  storage: Pick<SafeStorage, 'getItem' | 'setItem'>;
  notify: ShowNotification;
  /** The public download page when the build names none. */
  downloadUrl?: string | undefined;
};

const DISMISSED_KEY = 'desktop-banner-dismissed';

/** Offers the desktop app unless the visitor dismissed the offer before. Throws only as `notify` does. */
export function offerDesktopApp({
  storage,
  notify,
  downloadUrl = 'https://polkadot.com/get-started/polkadot-for-desktop',
}: Params): void {
  if (storage.getItem(DISMISSED_KEY) !== null) {
    return;
  }
  notify({
    label: 'Get Polkadot Desktop',
    text: 'Full experience with native performance',
    deeplink: downloadUrl,
    icon: DesktopIcon,
    dismissMs: 0,
    browserNotification: false,
    onDismiss() {
      storage.setItem(DISMISSED_KEY, '1');
    },
  });
}
