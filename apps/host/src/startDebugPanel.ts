// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The debug panel's chunk loads only in debug mode, so its load is the one place a failure to start it shows.

import { m, reportDefect, spans as S } from '@dotli/metrics';
import { log } from '@dotli/shared';
import type { DebugPanelHost, TruapiDebugMountModule } from '@dotli/truapi-debug-ui';

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
    reportDefect(error, {
      flow: 'ui',
      step: 'debug_panel_load',
      metric: S.DEBUG_PANEL_LOAD,
      message: '[dot.li] debug panel failed to start:',
    });
    return;
  }
  log.event('TrUAPI debug panel enabled', { flow: 'boot' });
  m.count(S.DEBUG_PANEL_LOAD, { outcome: 'ok' });
}
