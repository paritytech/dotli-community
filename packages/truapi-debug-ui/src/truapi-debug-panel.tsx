// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Entry of the lazily loaded debug panel, imported by the host only in debug mode.

import { flush } from 'solid-js';
import { onDotliDebugEvent, type DotliDebugBus } from '@dotli/truapi-debug';
import { mountRoot } from '@dotli/ui';
import { Panel, PANEL_ID } from './Panel.js';
import { pageEffects, type PanelEffects } from './effects.js';
import { createPanelFeed } from './feed.js';
import type { DebugPanelHost } from './host.js';
import { PanelWorkContext, panelWork, type PanelWork } from './work.js';

const ROOT = 'truapi-debug';
const DEFAULT_CAPACITY = 2000;

export interface SetupOptions {
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
  bus?: Pick<DotliDebugBus, 'on'>;
}

/**
 * Install the debug panel, returning a dispose that also gives the product iframe its full size back.
 *
 * A second call before disposing is a no-op.
 */
export function setupTruapiDebugPanel(options: SetupOptions): () => void {
  if (document.getElementById(PANEL_ID) !== null) {
    return () => {
      /* already mounted, the owner disposes the original handle */
    };
  }

  const container = document.createElement('div');
  document.body.appendChild(container);

  const { store, resolution, unsubscribe } = createPanelFeed({
    bus: options.bus ?? { on: onDotliDebugEvent },
    capacity: options.capacity ?? DEFAULT_CAPACITY,
  });

  const View = options.view ?? Panel;
  const disposeView = mountRoot(
    ROOT,
    container,
    () => (
      <PanelWorkContext value={options.work ?? panelWork}>
        <View
          store={store}
          resolution={resolution}
          startCollapsed={options.startCollapsed ?? false}
          loadArchive={options.host.archive}
          host={options.host}
          effects={options.effects ?? pageEffects}
        />
      </PanelWorkContext>
    ),
    // A render error, even a late one, tears the panel down rather than leave it frozen with timers running.
    { removeContainer: true, onBroken: unsubscribe },
  );
  // Callers expect the panel, its layout and the iframe fit in place on return.
  flush();

  return () => {
    unsubscribe();
    disposeView();
  };
}
