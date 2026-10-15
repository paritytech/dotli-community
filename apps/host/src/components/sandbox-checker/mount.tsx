// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Loaded on demand, and only in sandbox-checker builds, so no production visit fetches it.

import type { JSX } from '@solidjs/web';
import { mountRoot } from '@dotli/ui';
import { setDockInset } from '../../product-frame-layout.js';
import { ViolationPanel, type ViolationPanelProps } from './ViolationPanel.js';

const ROOT = 'sandbox-checker';

/** The panel the page shows, which reports the height it covers at the bottom. */
export type ViolationPanelView = (props: ViolationPanelProps) => JSX.Element;

/**
 * Shows the violation panel for `iframe`, keeping the product frame clear of it, and returns a dispose that may run
 * more than once. A render error, even a late one, disposes and removes the panel so it never stays frozen and
 * running. A test passes its own `View`.
 */
export function mountViolationPanel(iframe: HTMLIFrameElement, View: ViolationPanelView = ViolationPanel): () => void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return mountRoot(
    ROOT,
    container,
    () => (
      <View
        iframe={iframe}
        onReserve={bottom => {
          setDockInset({ right: 0, bottom }, 'sandbox-checker');
        }}
      />
    ),
    { removeContainer: true },
  );
}
