// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { getActiveServicesConfig, getSettings, setSettings } from '@dotli/config';
import { bindCaptureSink } from '@dotli/metrics';
import type { RemoteChainProvider } from '@dotli/protocol';
import {
  createFinalizedBlockQuery,
  createPageDiagnostics,
  type FinalizedBlockClient,
  type PageDiagnosticsDeps,
} from './diagnostics.js';
import { bindRecordingSentry, type RecordingSentry } from '@dotli/metrics/testing';
import { resetAllStoresForTests } from '@dotli/shared/testing';
import { setProductLoaded } from './state/product.js';

const people = getActiveServicesConfig().people.genesis;
const provider: RemoteChainProvider = () => ({ send: vi.fn(), disconnect: vi.fn() });

function clientReading(block: Promise<{ number: number }>): FinalizedBlockClient & { destroy: Mock<() => void> } {
  return { getFinalizedBlock: () => block, destroy: vi.fn<() => void>() };
}

describe('queryFinalizedBlock', () => {
  const captures = { exception: vi.fn(), expected: vi.fn() };
  let metrics: RecordingSentry;
  let unbindCaptures: () => void;

  beforeEach(() => {
    metrics = bindRecordingSentry({ onFinished: onTestFinished });
    unbindCaptures = bindCaptureSink(captures);
  });

  afterEach(() => {
    unbindCaptures();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("As a dotli user, the diagnostics read a chain's finalized block over the host pool", async () => {
    // Given
    const client = clientReading(Promise.resolve({ number: 42 }));
    const source = {
      provider: vi.fn((_genesisHash: string) => Promise.resolve(provider)),
      createClient: vi.fn((_provider: RemoteChainProvider) => Promise.resolve(client)),
    };
    const queryFinalizedBlock = createFinalizedBlockQuery(source);

    // When
    const block = await queryFinalizedBlock(people);

    // Then
    expect(block).toBe(42);
    expect(source.provider).toHaveBeenCalledWith(people);
    expect(source.createClient).toHaveBeenCalledWith(provider);
    expect(client.destroy).toHaveBeenCalledOnce();
  });

  it('As a dotli user, the diagnostics read no block for a chain the host pool cannot serve', async () => {
    // Given
    const createClient = vi.fn((_provider: RemoteChainProvider) =>
      Promise.resolve(clientReading(Promise.resolve({ number: 1 }))),
    );
    const queryFinalizedBlock = createFinalizedBlockQuery({ provider: () => Promise.resolve(null), createClient });

    // When
    const block = await queryFinalizedBlock(people);

    // Then
    expect(block).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('As a dotli user, the diagnostics read no block from a chain that fails to answer and close its client', async () => {
    // Given
    const client = clientReading(Promise.reject(new Error('chainHead follow failed')));
    const queryFinalizedBlock = createFinalizedBlockQuery({
      provider: () => Promise.resolve(provider),
      createClient: () => Promise.resolve(client),
    });

    // When
    const block = await queryFinalizedBlock(people);

    // Then
    expect(block).toBeNull();
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(expect.objectContaining({ message: 'chainHead follow failed' }), {
      flow: 'ui',
      step: 'diagnostics_block',
      tags: { reason: 'Error' },
    });
    expect(metrics.counted('diagnostics.finalized_block')).toEqual([{ outcome: 'error', reason: 'Error' }]);
  });

  it('As a dotli maintainer, a client that throws as it closes after answering is counted once, as an error', async () => {
    // Given a chain that answers, on a client whose close throws
    const client = clientReading(Promise.resolve({ number: 42 }));
    client.destroy.mockImplementation(() => {
      throw new Error('client would not close');
    });
    const queryFinalizedBlock = createFinalizedBlockQuery({
      provider: () => Promise.resolve(provider),
      createClient: () => Promise.resolve(client),
    });

    // When
    await queryFinalizedBlock(people);

    // Then the query is counted once, for the close that failed
    expect(metrics.counted('diagnostics.finalized_block')).toEqual([{ outcome: 'error', reason: 'Error' }]);
    expect(captures.exception).toHaveBeenCalledTimes(1);
  });

  it('As a dotli user, an answered finalized block query leaves no timer behind', async () => {
    // Given
    vi.useFakeTimers();
    const queryFinalizedBlock = createFinalizedBlockQuery({
      provider: () => Promise.resolve(provider),
      createClient: () => Promise.resolve(clientReading(Promise.resolve({ number: 42 }))),
    });

    // When
    const block = await queryFinalizedBlock(people);

    // Then
    expect(block).toBe(42);
    expect(vi.getTimerCount()).toBe(0);
    expect(metrics.counted('diagnostics.finalized_block')).toEqual([{ outcome: 'ok' }]);
  });

  it('As a dotli user, a chain that does not answer within the limit is left as a breadcrumb once and reads as no block', async () => {
    // Given
    vi.useFakeTimers();
    const client = clientReading(new Promise<never>(() => undefined));
    const queryFinalizedBlock = createFinalizedBlockQuery({
      provider: () => Promise.resolve(provider),
      createClient: () => Promise.resolve(client),
    });

    // When
    const query = queryFinalizedBlock(people);
    await vi.advanceTimersByTimeAsync(10_000);

    // Then
    expect(await query).toBeNull();
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(captures.exception).not.toHaveBeenCalled();
    expect(captures.expected).toHaveBeenCalledTimes(1);
    expect(captures.expected).toHaveBeenCalledWith(expect.any(Error), { flow: 'ui', step: 'diagnostics_block' });
    expect(metrics.counted('diagnostics.finalized_block')).toEqual([{ outcome: 'timeout', reason: 'timeout' }]);
  });
});

describe('createPageDiagnostics', () => {
  /** The page's diagnostics on `site`, over a trusted provider connected to `node` and chains that answer `block`. */
  function pageDiagnostics(node: string | null, block: number | null = null, site = 'dot.li') {
    const deps = {
      connectedAssetHubNode: vi.fn<PageDiagnosticsDeps['connectedAssetHubNode']>(() => node),
      finalizedBlock: vi.fn<PageDiagnosticsDeps['finalizedBlock']>(() => Promise.resolve(block)),
      openIssue: vi.fn<PageDiagnosticsDeps['openIssue']>(),
      page: () => ({ site, userAgent: 'Mozilla/5.0 (Macintosh) Chrome/147.0' }),
    };
    return { deps, diagnostics: createPageDiagnostics(deps) };
  }

  it('As a dotli developer on trusted providers, the AssetHub row names the node the client is connected to', () => {
    // Given
    onTestFinished(setSettings({ ...getSettings(), backend: 'rpc-gateway' }));
    const { diagnostics } = pageDiagnostics('wss://live.example');

    // When
    const rows = diagnostics.rows();

    // Then
    expect(rows.find(([label]) => label === 'AssetHub node')).toEqual(['AssetHub node', 'wss://live.example', true]);
  });

  it('As a dotli developer on trusted providers before the client connects, the AssetHub row names the first node', () => {
    // Given
    onTestFinished(setSettings({ ...getSettings(), backend: 'rpc-gateway' }));
    const { diagnostics } = pageDiagnostics(null);

    // When
    const rows = diagnostics.rows();

    // Then
    expect(rows.find(([label]) => label === 'AssetHub node')).toEqual([
      'AssetHub node',
      getActiveServicesConfig().assethub.rpcs[0],
      true,
    ]);
  });

  it('As a dotli developer, only the site and the node rows are marked as worth copying', () => {
    // Given
    onTestFinished(setSettings({ ...getSettings(), backend: 'rpc-gateway' }));
    const { diagnostics } = pageDiagnostics('wss://live.example');

    // When
    const rows = diagnostics.rows();

    // Then
    expect(rows.filter(row => row[2] === true).map(([label]) => label)).toEqual([
      'Site',
      'Relay node',
      'AssetHub node',
      'Bulletin Node',
    ]);
  });

  it.each(['', 'n/a'])('As a dotli developer, a row with nothing to copy (%j) is not offered for copying', site => {
    // Given
    onTestFinished(setSettings({ ...getSettings(), backend: 'rpc-gateway' }));
    const { diagnostics } = pageDiagnostics('wss://live.example', null, site);

    // When
    const rows = diagnostics.rows();

    // Then
    expect(rows.find(([label]) => label === 'Site')).toStrictEqual(['Site', site]);
  });

  it('As a dotli developer on the light client, the rows ask no trusted provider for its node', () => {
    // Given
    onTestFinished(setSettings({ ...getSettings(), backend: 'smoldot-direct' }));
    const { deps, diagnostics } = pageDiagnostics('wss://live.example');

    // When
    const rows = diagnostics.rows();

    // Then
    expect(rows.map(([label]) => label)).not.toContain('AssetHub node');
    expect(deps.connectedAssetHubNode).not.toHaveBeenCalled();
  });

  it("As a dotli developer, the rows name the loaded product's manifest version and app version", () => {
    // Given
    onTestFinished(resetAllStoresForTests);
    onTestFinished(setSettings({ ...getSettings(), backend: 'smoldot-direct' }));
    setProductLoaded('doom', 'doom.dot', { cid: 'bafy', manifestVersion: 1, appVersion: [1, 2, 3, 'beta'] });
    const { diagnostics } = pageDiagnostics('wss://live.example');

    // When
    const rows = diagnostics.rows();

    // Then
    expect(rows).toContainEqual(['Manifest', 'v1']);
    expect(rows).toContainEqual(['App version', '1.2.3-beta']);
  });

  it("As a dotli developer on the light client, the report lists the rows, the cache, the packages and each chain's finalized height", async () => {
    // Given
    onTestFinished(setSettings({ ...getSettings(), backend: 'smoldot-direct' }));
    const { deps, diagnostics } = pageDiagnostics(null, 1234);
    const rows = diagnostics.rows();
    const row = (label: string): string => rows.find(([name]) => name === label)?.[1] ?? '';

    // When
    const report = await diagnostics.report(rows);

    // Then
    expect(report).toBe(
      [
        'Site: dot.li',
        'Build: 0.0.0 (dev)',
        `Network: ${row('Network')}`,
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
    const cfg = getActiveServicesConfig();
    expect(deps.finalizedBlock.mock.calls).toEqual([[cfg.relay.genesis], [cfg.assethub.genesis], [cfg.people.genesis]]);
  });

  it('As a dotli developer on trusted providers, the report names the node the tab shows and asks no chain', async () => {
    // Given
    onTestFinished(setSettings({ ...getSettings(), backend: 'rpc-gateway' }));
    const { deps, diagnostics } = pageDiagnostics('wss://live.example');

    // When
    const report = await diagnostics.report(diagnostics.rows());

    // Then
    expect(report).toContain('AssetHub node: wss://live.example');
    expect(report).not.toContain('Finalized:');
    expect(deps.finalizedBlock).not.toHaveBeenCalled();
  });
});
