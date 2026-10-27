// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Entry of the lazily loaded debug panel, loaded only in debug mode.

import { flush } from 'solid-js';
import { debugBus, type DebugBus } from '@dotli/truapi-debug';
import { mountRoot } from '@dotli/ui';
import { Panel, PANEL_ID } from './Panel.js';
import { pageEffects, type PanelEffects } from './panelEffects.js';
import { createPanelFeed } from './createPanelFeed.js';
import type { DebugPanelHost } from './host.js';
import { PanelWorkContext, panelWork, type PanelWork } from './panelWork.js';

export type SetupParams = {
  /** What the panel reads of the host page and asks of it. */
  host: DebugPanelHost;
  /** Retained events before the oldest are evicted. */
  capacity?: number;
  /** Set when debug mode is auto-enabled in dev, so the panel does not cover content unasked. */
  startCollapsed?: boolean;
  /** The panel's repeated computations, replaced only to count them. */
  work?: PanelWork;
  /** Without one, the debug panel itself. */
  view?: typeof Panel;
  /** Without them, the page's own clipboard and download. */
  effects?: PanelEffects;
  /** Without one, the page's bus. */
  bus?: Pick<DebugBus, 'subscribe'>;
};

const ROOT = 'truapi-debug';
const DEFAULT_CAPACITY = 2000;

/**
 * Install the debug panel, returning a dispose that also gives the product iframe its full size back.
 *
 * A second call before disposing is a no-op, and its dispose does nothing. A panel that fails to render is torn down,
 * not thrown.
 */
export function setupTruapiDebugPanel({
  host,
  capacity = DEFAULT_CAPACITY,
  startCollapsed = false,
  work = panelWork,
  view: View = Panel,
  effects = pageEffects,
  bus = debugBus,
}: SetupParams): () => void {
  if (document.getElementById(PANEL_ID) !== null) {
    return () => {
      /* already mounted, the owner disposes the original handle */
    };
  }

  const container = document.createElement('div');
  document.body.appendChild(container);

  const { store, resolution, dispose: disposeFeed } = createPanelFeed({ bus, capacity });

  const disposeView = mountRoot({
    name: ROOT,
    container,
    view: () => (
      <PanelWorkContext value={work}>
        <View store={store} resolution={resolution} startCollapsed={startCollapsed} host={host} effects={effects} />
      </PanelWorkContext>
    ),
    // A render error, even a late one, tears the panel down rather than leave it frozen with timers running.
    removeContainer: true,
    onBroken: disposeFeed,
  });
  // Callers expect the panel, its layout and the iframe fit in place on return.
  flush();

  return dispose;

  function dispose(): void {
    disposeFeed();
    disposeView();
  }
}
