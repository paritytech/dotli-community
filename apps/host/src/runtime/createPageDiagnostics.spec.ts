// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { getActiveServicesConfig, getSettings, setSettings } from '@dotli/config';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { createPageDiagnostics, type PageDiagnosticsParams } from './createPageDiagnostics.js';
import { productState } from './state/productState.js';

type Params = {
  /** The node the trusted provider is connected to, or null before it connects. */
  node: string | null;
  /** The finalized block every chain answers, none by default. */
  block?: number | null;
  /** The page's site, `dot.li` by default. */
  site?: string;
};

describe('createPageDiagnostics', () => {
  /** The page's diagnostics over a trusted provider and chains that answer as the test asks. */
  function createDiagnosticsHarness({ node, block = null, site = 'dot.li' }: Params) {
    const params = {
      connectedAssetHubNode: vi.fn<PageDiagnosticsParams['connectedAssetHubNode']>(() => node),
      finalizedBlock: vi.fn<PageDiagnosticsParams['finalizedBlock']>(() => Promise.resolve(block)),
      openIssue: vi.fn<PageDiagnosticsParams['openIssue']>(),
      page: () => ({ site, userAgent: 'Mozilla/5.0 (Macintosh) Chrome/147.0' }),
      permissionStatuses: vi.fn<PageDiagnosticsParams['permissionStatuses']>((_label, names) =>
        Promise.resolve(names.map((): 'ask' => 'ask')),
      ),
    };
    return { params, diagnostics: createPageDiagnostics(params) };
  }

  it('As a dotli developer on trusted providers, I read the diagnostics and the AssetHub row names the node the client is connected to', () => {
    // Given a trusted provider connected to a node
    onTestFinished(setSettings({ ...getSettings(), backend: 'rpc-gateway' }));
    const { diagnostics } = createDiagnosticsHarness({ node: 'wss://live.example' });

    // When the rows are read
    const rows = diagnostics.rows();

    // Then the AssetHub row names that node and is worth copying
    expect(rows.find(([label]) => label === 'AssetHub node')).toEqual(['AssetHub node', 'wss://live.example', true]);
  });

  it('As a dotli developer on trusted providers, I read the diagnostics before the client connects and the AssetHub row names the first node', () => {
    // Given a trusted provider not connected yet
    onTestFinished(setSettings({ ...getSettings(), backend: 'rpc-gateway' }));
    const { diagnostics } = createDiagnosticsHarness({ node: null });

    // When the rows are read
    const rows = diagnostics.rows();

    // Then the AssetHub row names the first configured node
    expect(rows.find(([label]) => label === 'AssetHub node')).toEqual([
      'AssetHub node',
      getActiveServicesConfig().assethub.rpcs[0],
      true,
    ]);
  });

  it('As a dotli developer, I read the diagnostics and only the site and the node rows are marked as worth copying', () => {
    // Given a trusted provider connected to a node
    onTestFinished(setSettings({ ...getSettings(), backend: 'rpc-gateway' }));
    const { diagnostics } = createDiagnosticsHarness({ node: 'wss://live.example' });

    // When the rows are read
    const rows = diagnostics.rows();

    // Then only the site and node rows are marked
    expect(rows.filter(row => row[2] === true).map(([label]) => label)).toEqual([
      'Site',
      'Relay node',
      'AssetHub node',
      'Bulletin Node',
    ]);
  });

  it.each(['', 'n/a'])(
    'As a dotli developer, I read the diagnostics on a site with nothing to copy (%j) and its row is not offered for copying',
    site => {
      // Given a page whose site has nothing to copy
      onTestFinished(setSettings({ ...getSettings(), backend: 'rpc-gateway' }));
      const { diagnostics } = createDiagnosticsHarness({ node: 'wss://live.example', site });

      // When the rows are read
      const rows = diagnostics.rows();

      // Then the site row carries no copy mark
      expect(rows.find(([label]) => label === 'Site')).toStrictEqual(['Site', site]);
    },
  );

  it('As a dotli developer on the light client, I read the diagnostics and no trusted provider is asked for its node', () => {
    // Given the light client
    onTestFinished(setSettings({ ...getSettings(), backend: 'smoldot-direct' }));
    const { params, diagnostics } = createDiagnosticsHarness({ node: 'wss://live.example' });

    // When the rows are read
    const rows = diagnostics.rows();

    // Then no AssetHub node row is shown and no provider was asked
    expect(rows.map(([label]) => label)).not.toContain('AssetHub node');
    expect(params.connectedAssetHubNode).not.toHaveBeenCalled();
  });

  it("As a dotli developer, I read the diagnostics and the rows name the loaded product's manifest version and app version", () => {
    // Given a loaded product with a manifest and app version
    onTestFinished(resetAllStoresForTests);
    onTestFinished(setSettings({ ...getSettings(), backend: 'smoldot-direct' }));
    productState.setLoaded({
      label: 'doom',
      productId: 'doom.dot',
      details: { cid: 'bafy', manifestVersion: 1, appVersion: [1, 2, 3, 'beta'] },
    });
    const { diagnostics } = createDiagnosticsHarness({ node: 'wss://live.example' });

    // When the rows are read
    const rows = diagnostics.rows();

    // Then both versions are shown
    expect(rows).toContainEqual(['Manifest', 'v1']);
    expect(rows).toContainEqual(['App version', '1.2.3-beta']);
  });

  it("As a dotli developer on the light client, I copy the report and it lists the rows, the cache, the packages and each chain's finalized height", async () => {
    // Given the light client over chains that answer one height
    onTestFinished(setSettings({ ...getSettings(), backend: 'smoldot-direct' }));
    const servicesConfig = getActiveServicesConfig();
    const { params, diagnostics } = createDiagnosticsHarness({ node: null, block: 1234 });
    const rows = diagnostics.rows();
    const readRow = (label: string): string => rows.find(([name]) => name === label)?.[1] ?? '';

    // When the report is built
    const report = await diagnostics.report(rows);

    // Then it lists every section and asked each chain once
    expect(report).toBe(
      [
        'Site: dot.li',
        'Build: 0.0.0 (dev)',
        `Network: ${readRow('Network')}`,
        'Transport: Light client per tab',
        'Browser: Chrome 147 (macOS)',
        '',
        'Cache:',
        '  dotNS cache: on',
        '  Archive cache: on',
        '  Worker cache: on',
        '',
        'Packages:',
        '  smoldot: unknown',
        '',
        'Finalized:',
        '  Relay: #1,234',
        '  Asset Hub: #1,234',
        '  People: #1,234',
      ].join('\n'),
    );
    expect(params.finalizedBlock.mock.calls).toEqual([
      [servicesConfig.relay.genesis],
      [servicesConfig.assethub.genesis],
      [servicesConfig.people.genesis],
    ]);
  });

  it('As a dotli developer on trusted providers, I copy the report and it names the node the tab shows and asks no chain', async () => {
    // Given a trusted provider connected to a node
    onTestFinished(setSettings({ ...getSettings(), backend: 'rpc-gateway' }));
    const { params, diagnostics } = createDiagnosticsHarness({ node: 'wss://live.example' });

    // When the report is built
    const report = await diagnostics.report(diagnostics.rows());

    // Then it names the node and has no finalized heights
    expect(report).toContain('AssetHub node: wss://live.example');
    expect(report).not.toContain('Finalized:');
    expect(params.finalizedBlock).not.toHaveBeenCalled();
  });
});
