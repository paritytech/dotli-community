// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One page's overlays and notifications, which each app creates once with its own reporter. Imports no Solid,
// since both apps' boot imports it, and the overlays chunk is imported only on first use.

import type { Reporter } from '@dotli/ui-core';
import { loadOverlaysMount } from './lazy.js';
import { createNotifier, type ShowNotification } from './notification.js';
import { createOverlays, type Overlays } from './overlays/load.js';

export interface PageOverlays extends Overlays {
  showNotification: ShowNotification;
}

/** The page's toast and dialog overlays and its notifier. `report` takes what fails in them and in their chunk. */
export function createPageOverlays(report: Reporter): PageOverlays {
  const overlays = createOverlays({
    load: onBroken => loadOverlaysMount().then(({ mountOverlays }) => mountOverlays(onBroken, report)),
    confirm: text => window.confirm(text),
    report: report.failure,
  });
  return {
    ...overlays,
    showNotification: createNotifier({
      present: overlays.presentToast,
      visible: () => document.visibilityState === 'visible',
      system: () => ('Notification' in window ? window.Notification : undefined),
    }),
  };
}
