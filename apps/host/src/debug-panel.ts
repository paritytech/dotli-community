// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The debug panel's chunk loads only in debug mode, so its load is the one place a failure to start it shows.

import { captureException, m, spans as S } from '@dotli/metrics';
import { errorName, log } from '@dotli/shared';
import type { DebugPanelHost, TruapiDebugMountModule } from '@dotli/truapi-debug-ui';

export interface DebugPanelDeps {
  load: () => Promise<Pick<TruapiDebugMountModule, 'setupTruapiDebugPanel'>>;
  /** Loads beside the panel, so nothing the panel reads joins the boot chunk. */
  host: () => Promise<DebugPanelHost>;
  /** Set when debug mode is on by default, so the panel does not cover content unasked. */
  startCollapsed: boolean;
}

/** Loads and mounts the debug panel. Never rejects: a failure is reported here, and the page goes on without it. */
export async function startDebugPanel({ load, host, startCollapsed }: DebugPanelDeps): Promise<void> {
  try {
    const [{ setupTruapiDebugPanel }, panelHost] = await Promise.all([load(), host()]);
    setupTruapiDebugPanel({ startCollapsed, host: panelHost });
  } catch (err: unknown) {
    log.error('[dot.li] debug panel failed to start:', err);
    captureException(err, { flow: 'ui', step: 'debug_panel_load' });
    m.count(S.DEBUG_PANEL_LOAD, { outcome: 'error', reason: errorName(err) ?? 'unknown' });
    return;
  }
  log.event('TrUAPI debug panel enabled', { flow: 'boot' });
  m.count(S.DEBUG_PANEL_LOAD, { outcome: 'ok' });
}
