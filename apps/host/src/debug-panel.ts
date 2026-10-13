// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The debug panel's chunk loads only in debug mode, so its load is the one place a failure to start it shows.

import type { ArchiveFiles } from '@dotli/content';
import { captureException, m, spans as S } from '@dotli/metrics';
import { errorName, log } from '@dotli/shared';
import type { DebugPanelHost, TruapiDebugMountModule } from '@dotli/truapi-debug-ui';

export type DebugPanelOptions = Omit<Parameters<TruapiDebugMountModule['setupTruapiDebugPanel']>[0], 'host'>;
type DockInset = Parameters<DebugPanelHost['reportDockInset']>[0];

/** One block's bytes by CID, as the host's sandbox relay serves them. */
type BlockSource = (cid: string) => Promise<Uint8Array>;

export interface DebugPanelDeps {
  load: () => Promise<Pick<TruapiDebugMountModule, 'setupTruapiDebugPanel'>>;
  /** Loads beside the panel, so nothing the panel reads joins the boot chunk. */
  host: () => Promise<DebugPanelHost>;
  options: DebugPanelOptions;
}

/** Loads and mounts the debug panel. Never rejects: a failure is reported here, and the page goes on without it. */
export async function startDebugPanel({ load, host, options }: DebugPanelDeps): Promise<void> {
  try {
    const [{ setupTruapiDebugPanel }, panelHost] = await Promise.all([load(), host()]);
    setupTruapiDebugPanel({ ...options, host: panelHost });
  } catch (err: unknown) {
    log.error('[dot.li] debug panel failed to start:', err);
    captureException(err, { flow: 'ui', step: 'debug_panel_load' });
    m.count(S.DEBUG_PANEL_LOAD, { outcome: 'error', reason: errorName(err) ?? 'unknown' });
    return;
  }
  log.event('TrUAPI debug panel enabled', { flow: 'boot' });
  m.count(S.DEBUG_PANEL_LOAD, { outcome: 'ok' });
}

/** What the page gives the panel, before it is shaped into the panel's port. */
export interface DebugPanelParts extends Pick<
  DebugPanelHost,
  'product' | 'auth' | 'walletMode' | 'walletSwitch' | 'phraseToEntropy' | 'diagnostics' | 'leaveDebugMode'
> {
  /** Reads a product archive by its root CID, over blocks or over the IPFS gateway. */
  readArchive: (cid: string, transport: { blockSource: BlockSource } | { gateway: true }) => Promise<ArchiveFiles>;
  /** Whether the sandbox reads content over the gateway, so the Archive tab reads what the product was served. */
  viaGateway: () => boolean;
  topbarPresent: () => boolean;
  setDockInset: (inset: DockInset, source: 'debug') => void;
}

/**
 * The page as the debug panel reads it. The Archive tab reads what the sandbox was served: `blockSource` on the light
 * client, the gateway when content comes over it.
 */
export function debugPanelHost(parts: DebugPanelParts, blockSource: BlockSource): DebugPanelHost {
  return {
    product: parts.product,
    auth: parts.auth,
    walletMode: parts.walletMode,
    walletSwitch: parts.walletSwitch,
    phraseToEntropy: parts.phraseToEntropy,
    diagnostics: parts.diagnostics,
    archive: cid =>
      parts.viaGateway() ? parts.readArchive(cid, { gateway: true }) : parts.readArchive(cid, { blockSource }),
    contentInsets: { top: 'var(--content-top)', bottom: 'var(--content-bottom)' },
    topbarPresent: parts.topbarPresent,
    reportDockInset: inset => {
      parts.setDockInset(inset, 'debug');
    },
    leaveDebugMode: parts.leaveDebugMode,
  };
}
