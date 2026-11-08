// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The debug panel's chunk loads only in debug mode, so its load is the one place a failure to start it shows.

import { createReporter, defineCount } from '@dotli/metrics';
import type { DebugPanelHost, TruapiDebugMountModule } from '@dotli/truapi-debug-ui';

const uiReport = createReporter({ flow: 'ui' });
const bootReport = createReporter({ flow: 'boot' });

/**
 * One start of the debug panel in debug mode. Tagged `outcome` and, on error, `reason`, as a failed one shows no
 * panel.
 */
const debugPanelLoadMetric = defineCount<'error' | 'ok'>('debug_panel.load');

type Params = {
  load: () => Promise<Pick<TruapiDebugMountModule, 'setupTruapiDebugPanel'>>;
  /** Loads beside the panel, so nothing the panel reads joins the boot chunk. */
  host: () => Promise<DebugPanelHost>;
  /** Set when debug mode is on by default, so the panel does not cover content unasked. */
  startCollapsed: boolean;
};

/** Loads and mounts the debug panel. Never rejects: a failure is reported here, and the page goes on without it. */
export async function startDebugPanel({ load, host, startCollapsed }: Params): Promise<void> {
  try {
    const [{ setupTruapiDebugPanel }, panelHost] = await Promise.all([load(), host()]);
    setupTruapiDebugPanel({ startCollapsed, host: panelHost });
  } catch (error: unknown) {
    uiReport.defect(error, {
      step: 'debug_panel_load',
      metric: debugPanelLoadMetric,
      message: '[dot.li] debug panel failed to start:',
    });
    return;
  }
  bootReport.log.event('TrUAPI debug panel enabled');
  debugPanelLoadMetric.count({ outcome: 'ok' });
}
