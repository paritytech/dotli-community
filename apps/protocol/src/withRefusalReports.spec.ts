// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { SITE_ID } from '@dotli/config';
import { protocolSchema, type RemoteFailure } from '@dotli/protocol';
import { denied, domain, err, hostFailure, ok, type CallError } from '@dotli/transport';
import { withRefusalReports, type FrameRefusal } from './withRefusalReports.js';
import { closeHostLinks, linkHost } from './testing/linkHost.js';
import { record } from './testing/record.js';

afterEach(closeHostLinks);

const { frame, resolve, storage, wallet, chain } = protocolSchema.sections;

describe('the reporting transport', () => {
  it('As a dotli operator, I see a store call refused by its handler reported as refused, and the host hears it denied', async () => {
    // Given
    const link = linkHost();
    const refusals: FrameRefusal[] = [];
    withRefusalReports(link.serving, refusal => refusals.push(refusal)).handleRequest(storage.modeRead, () =>
      err(denied()),
    );

    // When
    const read = link.host.request(storage.modeRead, { siteId: SITE_ID, key: 'mode' });

    // Then
    await expect(read).resolves.toEqual(err(denied()));
    expect(refusals).toMatchObject([
      {
        route: 'mode',
        method: 'modeStorageRead',
        error: { name: 'Denied', message: 'The frame refused the call "modeStorageRead"' },
      },
    ]);
  });

  it('As a dotli operator, I see a failed request, a typed failure, a refused subscription and one that ends in error reported under their methods', async () => {
    // Given
    const link = linkHost();
    const refusals: FrameRefusal[] = [];
    const served = withRefusalReports(link.serving, refusal => refusals.push(refusal));
    const failure = new Error('read failed');
    const syncTimeout: CallError<RemoteFailure> = domain({ tag: 'syncTimeout', value: 'Asset Hub did not sync' });
    const refused = new Error('Connection limit reached (max 10)');
    const ended = hostFailure(new Error('Asset Hub did not sync'));
    served.handleRequest(wallet.read, () => Promise.reject(failure));
    served.handleRequest(resolve.owner, () => err(syncTimeout));
    served.handleSubscription(chain.connect, () => {
      throw refused;
    });
    served.handleSubscription(resolve.dotName, (_start, _context, sink) => {
      sink.interrupt(err(ended));
      return () => undefined;
    });

    // When
    const read = await link.host.request(wallet.read, { siteId: SITE_ID });
    const owner = await link.host.request(resolve.owner, { label: 'doom' });
    const connected = await record({
      transport: link.host,
      method: chain.connect,
      start: { genesisHash: '0xaa', connectionId: 'c1' },
    }).ended;
    const name = await record({ transport: link.host, method: resolve.dotName, start: { label: 'doom' } }).ended;

    // Then the host hears each failure, and each was reported first
    expect([read, owner, connected, name]).toEqual([
      err(hostFailure('Error: read failed')),
      err(syncTimeout),
      err(hostFailure('Error: Connection limit reached (max 10)')),
      err(ended),
    ]);
    expect(refusals).toMatchObject([
      { route: 'wallet', method: 'localWalletRead', error: failure },
      {
        route: 'chain',
        method: 'resolveOwner',
        error: { name: 'NetworkSyncTimeoutError', message: 'Asset Hub did not sync' },
      },
      { route: 'chain', method: 'chainConnect', error: refused },
      { route: 'chain', method: 'resolveDotName', error: { name: 'Error', message: 'Asset Hub did not sync' } },
    ]);
    expect(refusals[0]?.error).toBe(failure);
    expect(refusals[2]?.error).toBe(refused);
  });

  it('As a dotli operator, I watch calls succeed and subscriptions end cleanly and hear nothing of them', async () => {
    // Given
    const link = linkHost();
    const refusals: FrameRefusal[] = [];
    const served = withRefusalReports(link.serving, refusal => refusals.push(refusal));
    served.handleRequest(frame.warmup, () => ok());
    served.handleSubscription(resolve.dotName, (_start, _context, sink) => {
      sink.send({ tag: 'resolved', value: null });
      sink.interrupt(ok());
      return () => undefined;
    });

    // When
    const warmed = await link.host.request(frame.warmup, undefined);
    const read = record({ transport: link.host, method: resolve.dotName, start: { label: 'doom' } });

    // Then
    expect(warmed).toEqual(ok());
    expect(await read.ended).toEqual(ok());
    expect(read.events).toEqual([{ tag: 'resolved', value: null }]);
    expect(refusals).toEqual([]);
  });
});
