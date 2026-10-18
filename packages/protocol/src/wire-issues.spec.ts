// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { m, spans as S } from '@dotli/metrics';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';
import { bindLogSink } from '@dotli/shared';
import { createIssueReporter } from './wire-issues.js';

/** Every log line of this test, by level. */
function recordLog(): { level: string; message: string; attrs: Record<string, unknown> | undefined }[] {
  const lines: { level: string; message: string; attrs: Record<string, unknown> | undefined }[] = [];
  onTestFinished(
    bindLogSink({
      emit: (level, message, attrs) => {
        lines.push({ level, message, attrs });
      },
    }),
  );
  return lines;
}

describe('createIssueReporter', () => {
  it('As a dotli operator, I see each refused message counted once with its reason, and its cause in the trail', () => {
    // Given
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const lines = recordLog();
    const report = createIssueReporter('host', m.count);

    // When
    report({ kind: 'refused', reason: 'malformed', cause: new RangeError('the data is cut short') });
    report({ kind: 'refused', reason: 'not_bytes' });

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
    const lines = recordLog();
    const report = createIssueReporter('host', m.count);

    // When
    report({
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
    const lines = recordLog();
    const report = createIssueReporter('host', m.count);

    // When
    report({ kind: 'post_failed', error: new TypeError('The peer window is gone') });

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
    const report = createIssueReporter('host', m.count);

    // When
    report({ kind: 'listener_threw', error: new Error('listener bug') });

    // Then
    expect(captured).toEqual([{ flow: 'protocol', step: 'listener', tags: { owner: 'protocol.transport' } }]);
    expect(metrics.counted(S.LISTENER_DELIVERY)).toEqual([
      { outcome: 'error', reason: 'Error', owner: 'protocol.transport' },
    ]);
  });
});
