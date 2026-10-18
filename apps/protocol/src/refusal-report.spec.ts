// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { SITE_ID } from '@dotli/config';
import { spans as S, type m } from '@dotli/metrics';
import { isSharedAuthOriginAllowed, protocolSchema, type CallName } from '@dotli/protocol';
import { memoryStorage } from '@dotli/shared/testing';
import {
  createTransport,
  createWindowProvider,
  denied,
  domain,
  err,
  hostFailure,
  ok,
  type MessageTarget,
  type WindowLike,
} from '@dotli/transport';
import {
  createRefusalReporter,
  createWireReport,
  reportRefusals,
  type FrameRefusal,
  type FrameRoute,
} from './refusal-report.js';
import { createSharedStoreHandler } from './shared-store-handler.js';
import { closeHostLinks, HOST_ORIGIN, linkHost, PRODUCT_ORIGIN, record } from './testing/host-link.js';

afterEach(closeHostLinks);

const STRANGER = 'https://evil.example';
const FAILURE = new Error('storage read failed');

const failedMethods: Record<FrameRoute, CallName> = {
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

/** A log and a counter that keep what they were handed. */
function recorded(): {
  warned: unknown[][];
  counted: unknown[][];
  warn: (...args: unknown[]) => void;
  count: typeof m.count;
} {
  const warned: unknown[][] = [];
  const counted: unknown[][] = [];
  return {
    warned,
    counted,
    warn: (...args) => warned.push(args),
    count: (name, attributes) => counted.push([name, attributes]),
  };
}

describe('the protocol frame refusal report', () => {
  it.each(TABLE)('As a dotli operator, I see a failed $refusal.route call logged and counted as it should be', row => {
    // Given a reporter on its own log and counter
    const sinks = recorded();
    const report = createRefusalReporter(sinks);

    // When one call is refused
    report(row.refusal);

    // Then it is logged and counted as the table says
    expect({ warned: sinks.warned, counted: sinks.counted }).toEqual({ warned: row.warned, counted: row.counted });
  });
});

describe('the wire report', () => {
  it('As a dotli operator, I see each refused origin counted and logged once, however often it posts', () => {
    // Given a report on its own log and counter
    const sinks = recorded();
    const report = createWireReport('frame', sinks);

    // When a stranger keeps posting and a second one posts once
    report.onRefusedOrigin(STRANGER);
    report.onRefusedOrigin(STRANGER);
    report.onRefusedOrigin(STRANGER);
    report.onRefusedOrigin(PRODUCT_ORIGIN);

    // Then each origin is counted and logged on its first refusal only
    const refused = [S.PROTOCOL_WIRE_REFUSED, { outcome: 'refused', reason: 'origin', side: 'frame' }];
    expect(sinks.counted).toEqual([refused, refused]);
    expect(sinks.warned).toEqual([
      [`[dot.li protocol] Rejected protocol messages from disallowed origin: ${STRANGER}`],
      [`[dot.li protocol] Rejected protocol messages from disallowed origin: ${PRODUCT_ORIGIN}`],
    ]);
  });

  it("As a dotli operator, I see what the frame's provider and transport drop counted once each, under the frame's side", () => {
    // Given the frame's provider and transport on one report, as the frame wires them
    const sinks = recorded();
    const report = createWireReport('frame', sinks);
    const listeners = new Set<(event: MessageEvent) => void>();
    const page: MessageTarget = {
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    };
    const parent: WindowLike = { postMessage: () => undefined };
    createTransport(
      protocolSchema,
      createWindowProvider({
        listen: page,
        peer: () => parent,
        origin: isSharedAuthOriginAllowed,
        onNotBytes: report.onNotBytes,
        onRefusedOrigin: report.onRefusedOrigin,
      }),
      { handshake: 'accept', hello: { resolutionId: null }, onIssue: report.onIssue },
    );
    const deliver = (data: unknown, origin: string, source: unknown): void => {
      for (const listener of [...listeners]) {
        // The provider reads only these.
        listener({ data, origin, source } as unknown as MessageEvent);
      }
    };

    // When the host sends an object, a stranger sends bytes twice, and the host sends bytes that are no message
    deliver({ legacy: true }, HOST_ORIGIN, parent);
    deliver(new ArrayBuffer(8), STRANGER, {});
    deliver(new ArrayBuffer(8), STRANGER, {});
    deliver(new ArrayBuffer(2), HOST_ORIGIN, parent);

    // Then each is counted once, under its reason
    expect(sinks.counted.map(([, attributes]) => attributes)).toEqual([
      { outcome: 'refused', reason: 'not_bytes', side: 'frame' },
      { outcome: 'refused', reason: 'origin', side: 'frame' },
      { outcome: 'refused', reason: 'malformed', side: 'frame' },
    ]);
  });

  it("As a dotli operator, I see what the worker's transport refuses counted under the worker's side", () => {
    // Given
    const sinks = recorded();
    const report = createWireReport('worker', sinks);

    // When
    report.onIssue({ kind: 'refused', reason: 'invalid', cause: new Error('A stop came before the handshake') });

    // Then
    expect(sinks.counted).toEqual([
      [S.PROTOCOL_WIRE_REFUSED, { outcome: 'refused', reason: 'invalid', side: 'worker' }],
    ]);
  });
});

describe('the reporting transport', () => {
  it('As a dotli operator, I see a store call refused by its handler reported as refused, and the host hears it denied', async () => {
    // Given
    const link = linkHost(PRODUCT_ORIGIN);
    const refusals: FrameRefusal[] = [];
    const storage = memoryStorage();
    createSharedStoreHandler(
      reportRefusals(link.serving, refusal => refusals.push(refusal)),
      { storage: () => storage, channel: null },
    );

    // When
    const read = link.host.request('storage', 'modeRead', { siteId: SITE_ID, key: 'mode' });

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
    const served = reportRefusals(link.serving, refusal => refusals.push(refusal));
    const failure = new Error('read failed');
    const syncTimeout = domain({ tag: 'syncTimeout' as const, value: 'Asset Hub did not sync' });
    const refused = new Error('Connection limit reached (max 10)');
    const ended = hostFailure(new Error('Asset Hub did not sync'));
    served.handleRequest('wallet', 'read', () => Promise.reject(failure));
    served.handleRequest('resolve', 'owner', () => err(syncTimeout));
    served.handleSubscription('chain', 'connect', () => {
      throw refused;
    });
    served.handleSubscription('resolve', 'dotName', (_start, _context, sink) => {
      sink.interrupt(ended);
      return () => undefined;
    });

    // When
    const read = await link.host.request('wallet', 'read', { siteId: SITE_ID });
    const owner = await link.host.request('resolve', 'owner', { label: 'doom' });
    const chain = await record(link.host, 'chain', 'connect', { genesisHash: '0xaa', connectionId: 'c1' }).ended;
    const name = await record(link.host, 'resolve', 'dotName', { label: 'doom' }).ended;

    // Then the host hears each failure, and each was reported first
    expect([read, owner, chain, name]).toEqual([
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

  it('As a dotli operator, I hear nothing of calls that succeed or subscriptions that end cleanly', async () => {
    // Given
    const link = linkHost();
    const refusals: FrameRefusal[] = [];
    const served = reportRefusals(link.serving, refusal => refusals.push(refusal));
    served.handleRequest('frame', 'warmup', () => ok());
    served.handleSubscription('resolve', 'dotName', (_start, _context, sink) => {
      sink.receive({ tag: 'resolved', value: null });
      sink.interrupt();
      return () => undefined;
    });

    // When
    const warmed = await link.host.request('frame', 'warmup', undefined);
    const read = record(link.host, 'resolve', 'dotName', { label: 'doom' });

    // Then
    expect(warmed).toEqual(ok());
    expect(await read.ended).toEqual(ok());
    expect(read.events).toEqual([{ tag: 'resolved', value: null }]);
    expect(refusals).toEqual([]);
  });
});
