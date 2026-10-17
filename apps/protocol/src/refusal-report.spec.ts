// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { SITE_ID } from '@dotli/config';
import { spans as S } from '@dotli/metrics';
import { memoryStorage } from '@dotli/shared/testing';
import {
  createOriginRefusalReporter,
  createRefusalReporter,
  reportRefusals,
  type FrameRefusal,
  type FrameRoute,
} from './refusal-report.js';
import { createSharedStoreHandler } from './shared-store-handler.js';
import { closeHostLinks, linkHost, PRODUCT_ORIGIN, record } from './testing/host-link.js';

afterEach(closeHostLinks);

const STRANGER = 'https://evil.example';
const FAILURE = new Error('storage read failed');

const failedMethods: Record<FrameRoute, string> = {
  auth: 'authStorageWrite',
  mode: 'modeStorageWrite',
  wallet: 'localWalletRead',
  chain: 'resolveDotName',
};

interface Row {
  refusal: FrameRefusal;
  warned: unknown[][];
  counted: unknown[][];
}

const failed = (route: FrameRoute): FrameRefusal => ({
  route,
  method: failedMethods[route],
  error: FAILURE,
});

const TABLE: Row[] = [
  {
    refusal: failed('auth'),
    warned: [],
    counted: [[S.SHARED_STORAGE_REJECTED, { store: 'auth', reason: 'validation' }]],
  },
  {
    refusal: failed('mode'),
    warned: [],
    counted: [[S.SHARED_STORAGE_REJECTED, { store: 'mode', reason: 'validation' }]],
  },
  { refusal: failed('wallet'), warned: [['[dot.li protocol] localWalletRead failed', FAILURE]], counted: [] },
  { refusal: failed('chain'), warned: [['[dot.li protocol] resolveDotName failed', FAILURE]], counted: [] },
];

describe('the protocol frame refusal report', () => {
  it.each(TABLE)('As a dotli operator, I see a failed $refusal.route call logged and counted as it should be', row => {
    // Given a reporter on its own log and counter
    const warned: unknown[][] = [];
    const counted: unknown[][] = [];
    const report = createRefusalReporter({
      warn: (...args) => warned.push(args),
      count: (name, attributes) => counted.push([name, attributes]),
    });

    // When one call is refused
    report(row.refusal);

    // Then it is logged and counted as the table says
    expect({ warned, counted }).toEqual({ warned: row.warned, counted: row.counted });
  });
});

describe('the origin refusal report', () => {
  it('As a dotli operator, I see each refused origin counted and logged once, however often it posts', () => {
    // Given a reporter on its own log and counter
    const warned: unknown[][] = [];
    const counted: unknown[][] = [];
    const report = createOriginRefusalReporter({
      warn: (...args) => warned.push(args),
      count: (name, attributes) => counted.push([name, attributes]),
    });

    // When a stranger keeps posting and a second one posts once
    report(STRANGER);
    report(STRANGER);
    report(STRANGER);
    report(PRODUCT_ORIGIN);

    // Then each origin is counted and logged on its first refusal only
    const refused = [S.PROTOCOL_WIRE_REFUSED, { outcome: 'refused', reason: 'origin', side: 'frame' }];
    expect(counted).toEqual([refused, refused]);
    expect(warned).toEqual([
      [`[dot.li protocol] Rejected protocol messages from disallowed origin: ${STRANGER}`],
      [`[dot.li protocol] Rejected protocol messages from disallowed origin: ${PRODUCT_ORIGIN}`],
    ]);
  });
});

describe('the reporting serving transport', () => {
  it('As a dotli operator, I see a store call refused by its handler reported as failed, and the host still hears why', async () => {
    // Given
    const link = linkHost(PRODUCT_ORIGIN);
    const refusals: FrameRefusal[] = [];
    const storage = memoryStorage();
    createSharedStoreHandler(
      reportRefusals(link.serving, refusal => refusals.push(refusal)),
      { storage: () => storage, channel: null },
    );

    // When
    const read = link.host.request('modeStorageRead', { siteId: SITE_ID, key: 'mode' });

    // Then
    await expect(read).rejects.toThrow(`Shared auth request denied from origin: ${PRODUCT_ORIGIN}`);
    expect(refusals).toEqual([
      {
        route: 'mode',
        method: 'modeStorageRead',
        error: new Error(`Shared auth request denied from origin: ${PRODUCT_ORIGIN}`),
      },
    ]);
  });

  it('As a dotli operator, I see a failed request, a refused subscription and one that ends in error reported under their methods', async () => {
    // Given
    const link = linkHost();
    const refusals: FrameRefusal[] = [];
    const served = reportRefusals(link.serving, refusal => refusals.push(refusal));
    const failure = new Error('read failed');
    const refused = new Error('Connection limit reached (max 10)');
    const ended = new Error('Asset Hub did not sync');
    served.handleRequest('localWalletRead', () => Promise.reject(failure));
    served.handleSubscription('chainConnect', () => {
      throw refused;
    });
    served.handleSubscription('resolveDotName', (_payload, _context, sink) => {
      sink.end(ended);
      return () => undefined;
    });

    // When
    await expect(link.host.request('localWalletRead', { siteId: SITE_ID })).rejects.toThrow('read failed');
    await record(link.host, 'chainConnect', { genesisHash: '0xaa', connectionId: 'c1' }).ended;
    await record(link.host, 'resolveDotName', { label: 'doom' }).ended;

    // Then
    expect(refusals).toEqual([
      { route: 'wallet', method: 'localWalletRead', error: failure },
      { route: 'chain', method: 'chainConnect', error: refused },
      { route: 'chain', method: 'resolveDotName', error: ended },
    ]);
  });

  it('As a dotli operator, I hear nothing of calls that succeed or subscriptions that end cleanly', async () => {
    // Given
    const link = linkHost();
    const refusals: FrameRefusal[] = [];
    const served = reportRefusals(link.serving, refusal => refusals.push(refusal));
    served.handleRequest('warmup', () => undefined);
    served.handleSubscription('resolveDotName', (_payload, _context, sink) => {
      sink.send({ tag: 'resolved', value: null });
      sink.end();
      return () => undefined;
    });

    // When
    await link.host.request('warmup', undefined);
    const read = record(link.host, 'resolveDotName', { label: 'doom' });

    // Then
    expect(await read.ended).toBeNull();
    expect(read.events).toEqual([{ tag: 'resolved', value: null }]);
    expect(refusals).toEqual([]);
  });
});
