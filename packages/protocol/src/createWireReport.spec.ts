// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { recordLog } from '@dotli/shared/testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import { countMetric, type CountSink } from '@dotli/metrics';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';
import { createWireReport } from './createWireReport.js';

const PRODUCT_ORIGIN = 'http://bafy.app.localhost:5173';
const STRANGER = 'https://evil.example';

/** A log and a counter that keep what they were handed. */
function createRecordingSinks(): {
  warned: unknown[][];
  counted: unknown[][];
  warn: (...args: unknown[]) => void;
  count: CountSink;
} {
  const warned: unknown[][] = [];
  const counted: unknown[][] = [];
  return {
    warned,
    counted,
    warn: (...args) => warned.push(args),
    count: (metric, attributes) => counted.push([metric.name, attributes]),
  };
}

describe('the transport issues', () => {
  it('As a dotli operator, I see each refused message counted once with its reason, and its cause in the trail', () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const lines = recordLog({ onFinished: onTestFinished });
    const report = createWireReport({ side: 'host', count: countMetric });

    // When
    report.onIssue({ kind: 'refused', reason: 'malformed', cause: new RangeError('the data is cut short') });

    // Then
    expect(metrics.counted('protocol.wire_refused')).toEqual([
      { outcome: 'refused', reason: 'malformed', side: 'host' },
    ]);
    expect(lines).toMatchObject([
      {
        level: 'info',
        message: 'protocol message refused',
        attrs: { reason: 'malformed', side: 'host', cause: 'RangeError: the data is cut short' },
      },
    ]);
  });

  it("As a dotli operator, I see a call's message the provider could not post captured, logged and counted with its method and side", () => {
    // Given
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const lines = recordLog({ onFinished: onTestFinished });
    const report = createWireReport({ side: 'host', count: countMetric });

    // When
    report.onIssue({
      kind: 'post_failed',
      error: new TypeError('The peer window is gone'),
      call: { section: 'resolve', method: 'owner' },
    });

    // Then
    expect(captured).toMatchObject([{ step: 'serve_post', tags: { method: 'resolveOwner', side: 'host' } }]);
    expect(lines.filter(line => line.level === 'error').map(line => line.message)).toEqual([
      '[dot.li protocol] A resolveOwner message could not be posted The peer window is gone',
    ]);
    expect(metrics.counted('protocol.serve_post')).toEqual([{ outcome: 'error', reason: 'TypeError', side: 'host' }]);
  });

  it('As a dotli operator, I see a message of no call the provider could not post captured and logged with its side alone', () => {
    // Given
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const lines = recordLog({ onFinished: onTestFinished });
    const report = createWireReport({ side: 'host', count: countMetric });

    // When
    report.onIssue({ kind: 'post_failed', error: new TypeError('The peer window is gone') });

    // Then
    expect(captured).toMatchObject([{ step: 'serve_post', tags: { side: 'host' } }]);
    expect(lines.filter(line => line.level === 'error').map(line => line.message)).toEqual([
      '[dot.li protocol] A message could not be posted The peer window is gone',
    ]);
  });

  it('As a dotli operator, I see a listener that threw on the transport reported as a listener of the protocol', () => {
    // Given
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const report = createWireReport({ side: 'host', count: countMetric });

    // When
    report.onIssue({ kind: 'listener_threw', error: new Error('listener bug') });

    // Then
    expect(captured).toMatchObject([{ step: 'listener', tags: { owner: 'protocol.transport' } }]);
    expect(metrics.counted('listener.delivery')).toEqual([
      { outcome: 'error', reason: 'Error', owner: 'protocol.transport' },
    ]);
  });
});

describe('the wire report', () => {
  it('As a dotli operator, I see each refused origin counted and logged once, however often it posts', () => {
    // Given a report on its own log and counter
    const sinks = createRecordingSinks();
    const report = createWireReport({ side: 'frame', count: sinks.count, warn: sinks.warn });

    // When a stranger keeps posting and a second one posts once
    report.onRefusedOrigin(STRANGER);
    report.onRefusedOrigin(STRANGER);
    report.onRefusedOrigin(STRANGER);
    report.onRefusedOrigin(PRODUCT_ORIGIN);

    // Then each origin is counted and logged on its first refusal only
    const refused = ['protocol.wire_refused', { outcome: 'refused', reason: 'origin', side: 'frame' }];
    expect(sinks.counted).toEqual([refused, refused]);
    expect(sinks.warned).toEqual([
      [`[dot.li protocol] Rejected protocol messages from disallowed origin: ${STRANGER}`],
      [`[dot.li protocol] Rejected protocol messages from disallowed origin: ${PRODUCT_ORIGIN}`],
    ]);
  });
});
