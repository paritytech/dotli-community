// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A host for the debug panel with no page behind it. Its stores start as a fresh page's, and a test sets them.

import { createSyncStore, type ReadableStore, type SyncStore } from '@dotli/shared';
import type { DebugPanelHost, DiagnosticsRow, DockInset, HostAuth, HostProduct, HostWalletMode } from './host.js';

export interface FakeDebugPanelHost {
  host: DebugPanelHost;
  product: SyncStore<HostProduct>;
  auth: SyncStore<HostAuth>;
  walletMode: SyncStore<HostWalletMode>;
  topbarPresent: SyncStore<boolean>;
  /** The last room the panel took from the product frame. */
  dockInset: ReadableStore<DockInset>;
  /** Every room the panel reported, oldest first. */
  dockReports: readonly DockInset[];
  /** How often the panel asked to leave debug mode. */
  leaveRequests: () => number;
}

const ROWS: DiagnosticsRow[] = [
  ['Site', 'app.dot.li', true],
  ['Build', '1.4.0 (abc1234)'],
];

/** `parts` replace the host's own, such as a recording wallet switch. */
export function fakeDebugPanelHost(parts: Partial<DebugPanelHost> = {}): FakeDebugPanelHost {
  const product = createSyncStore<HostProduct>('fakeHostProduct', { status: 'none' });
  const auth = createSyncStore<HostAuth>('fakeHostAuth', { tag: 'Restoring' });
  const walletMode = createSyncStore<HostWalletMode>('fakeHostWalletMode', { mode: 'app', failure: null });
  const topbarPresent = createSyncStore('fakeHostTopbarPresent', false);
  const dockInset = createSyncStore<DockInset>('fakeHostDockInset', { right: 0, bottom: 0 });
  const dockReports: DockInset[] = [];
  let leaves = 0;
  const host: DebugPanelHost = {
    product,
    auth,
    walletMode,
    walletSwitch: { importPhrase: () => undefined, usePolkadotApp: () => undefined },
    diagnostics: {
      rows: () => ROWS.map((row): DiagnosticsRow => [...row]),
      lightClientVersion: () => '0.3.1',
      packages: () => ({ polkadotApi: [], parityTruapi: [] }),
      report: rows => Promise.resolve(rows.map(([label, value]) => `${label}: ${value}`).join('\n')),
      openIssue: () => undefined,
    },
    archive: () => Promise.resolve({}),
    contentInsets: { top: '0px', bottom: '0px' },
    topbarPresent: topbarPresent.get,
    reportDockInset: inset => {
      dockReports.push(inset);
      dockInset.set(inset);
    },
    leaveDebugMode: () => {
      leaves += 1;
    },
    ...parts,
  };
  return { host, product, auth, walletMode, topbarPresent, dockInset, dockReports, leaveRequests: () => leaves };
}
