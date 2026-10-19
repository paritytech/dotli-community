// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { recordLog } from '@dotli/shared/testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import { m, spans as S } from '@dotli/metrics';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';
import {
  createTransport,
  createWindowProvider,
  type MessageTarget,
  type WindowLike,
  type WindowMessage,
} from '@dotli/transport';
import { isSharedAuthOriginAllowed } from './auth-storage.js';
import { protocolSchema } from './schema.js';
import { createWireReport } from './wire-issues.js';

const HOST_ORIGIN = 'http://host-playground.localhost:5173';
const PRODUCT_ORIGIN = 'http://bafy.app.localhost:5173';
const STRANGER = 'https://evil.example';

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

describe('the transport issues', () => {
  it('As a dotli operator, I see each refused message counted once with its reason, and its cause in the trail', () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const lines = recordLog({ onFinished: onTestFinished });
    const report = createWireReport('host', { count: m.count });

    // When
    report.onIssue({ kind: 'refused', reason: 'malformed', cause: new RangeError('the data is cut short') });
    report.onNotBytes();

    // Then
    expect(metrics.counted(S.PROTOCOL_WIRE_REFUSED)).toEqual([
      { outcome: 'refused', reason: 'malformed', side: 'host' },
      { outcome: 'refused', reason: 'not_bytes', side: 'host' },
    ]);
    expect(lines).toEqual([
      {
        level: 'info',
        message: 'protocol message refused',
        attrs: { flow: 'protocol', reason: 'malformed', side: 'host', cause: 'RangeError: the data is cut short' },
      },
      {
        level: 'info',
        message: 'protocol message refused',
        attrs: { flow: 'protocol', reason: 'not_bytes', side: 'host' },
      },
    ]);
  });

  it("As a dotli operator, I see a call's message the provider could not post captured, logged and counted with its method and side", () => {
    // Given
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const lines = recordLog({ onFinished: onTestFinished });
    const report = createWireReport('host', { count: m.count });

    // When
    report.onIssue({
      kind: 'post_failed',
      error: new TypeError('The peer window is gone'),
      call: { trait: 'resolve', method: 'owner' },
    });

    // Then
    expect(captured).toEqual([
      { flow: 'protocol', step: 'serve_post', tags: { method: 'resolveOwner', side: 'host' } },
    ]);
    expect(lines.filter(line => line.level === 'error').map(line => line.message)).toEqual([
      '[dot.li protocol] A resolveOwner message could not be posted The peer window is gone',
    ]);
    expect(metrics.counted(S.PROTOCOL_SERVE_POST)).toEqual([{ outcome: 'error', reason: 'TypeError', side: 'host' }]);
  });

  it('As a dotli operator, I see a message of no call the provider could not post captured and logged with its side alone', () => {
    // Given
    const captured = recordCaptures({ onFinished: onTestFinished });
    const lines = recordLog({ onFinished: onTestFinished });
    const report = createWireReport('host', { count: m.count });

    // When
    report.onIssue({ kind: 'post_failed', error: new TypeError('The peer window is gone') });

    // Then
    expect(captured).toEqual([{ flow: 'protocol', step: 'serve_post', tags: { side: 'host' } }]);
    expect(lines.filter(line => line.level === 'error').map(line => line.message)).toEqual([
      '[dot.li protocol] A message could not be posted The peer window is gone',
    ]);
  });

  it('As a dotli operator, I see a listener that threw on the transport reported as a listener of the protocol', () => {
    // Given
    const captured = recordCaptures({ onFinished: onTestFinished });
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const report = createWireReport('host', { count: m.count });

    // When
    report.onIssue({ kind: 'listener_threw', error: new Error('listener bug') });

    // Then
    expect(captured).toEqual([{ flow: 'protocol', step: 'listener', tags: { owner: 'protocol.transport' } }]);
    expect(metrics.counted(S.LISTENER_DELIVERY)).toEqual([
      { outcome: 'error', reason: 'Error', owner: 'protocol.transport' },
    ]);
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
    const listeners = new Set<(event: WindowMessage) => void>();
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
        listener({ data, origin, source });
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
