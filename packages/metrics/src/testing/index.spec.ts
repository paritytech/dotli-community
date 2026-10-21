// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { m } from '../metrics.js';
import { bindRecordingSentry } from '@dotli/metrics/testing';

describe('bindRecordingSentry', () => {
  it('As a dotli developer, I read back every metric, measurement and tag the page reported', () => {
    // Given
    const recorder = bindRecordingSentry();

    // When
    m.count('test.loaded', { outcome: 'error', reason: 'TypeError' });
    m.count('test.other');
    m.distribution('test.latency', 12, 'millisecond', { outcome: 'ok' });
    m.gauge('test.depth', 3);
    m.measure('test.paint', 40);
    m.tag('mode', 'shared');
    recorder.restore();

    // Then
    expect(recorder.counted('test.loaded')).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
    expect(recorder.counts.map(c => c.name)).toEqual(['dotli.test.loaded', 'dotli.test.other']);
    expect(recorder.distributions).toEqual([
      { name: 'dotli.test.latency', value: 12, unit: 'millisecond', attributes: { outcome: 'ok' } },
    ]);
    expect(recorder.gauges).toEqual([{ name: 'dotli.test.depth', value: 3, unit: 'none', attributes: undefined }]);
    expect(recorder.measurements).toEqual([{ name: 'dotli.test.paint', value: 40, unit: 'millisecond' }]);
    expect(recorder.tags).toEqual([{ key: 'dotli.mode', value: 'shared' }]);
  });

  it('As a dotli developer, I restore my recorder and metrics go back to the one bound before', () => {
    // Given
    const outer = bindRecordingSentry();
    const inner = bindRecordingSentry();

    // When
    inner.restore();
    m.count('test.after_restore');
    outer.restore();

    // Then
    expect(inner.counts).toEqual([]);
    expect(outer.counted('test.after_restore')).toEqual([undefined]);
  });

  it('As a dotli developer, I hand my recorder to the runner and it is put back when my test finishes', () => {
    // Given a recorder whose restore the runner holds until the test finishes
    const outer = bindRecordingSentry();
    const finished: (() => void)[] = [];
    const inner = bindRecordingSentry({
      onFinished: restore => {
        finished.push(restore);
      },
    });

    // When the test finishes and a metric is counted after it
    for (const restore of finished) {
      restore();
    }
    m.count('test.after_finish');
    outer.restore();

    // Then the runner held one restore, and the metric went to the recorder bound before
    expect(finished).toHaveLength(1);
    expect(inner.counts).toEqual([]);
    expect(outer.counted('test.after_finish')).toEqual([undefined]);
  });

  it('As a dotli developer, I hear each report as it is recorded, so I wait on it rather than polling', () => {
    // Given
    const heard: string[] = [];
    const recorder = bindRecordingSentry({
      onRecord: () => {
        heard.push(
          `${String(recorder.counts.length)}/${String(recorder.measurements.length)}/${String(recorder.tags.length)}`,
        );
      },
    });

    // When
    m.count('test.loaded');
    m.measure('test.paint', 40);
    m.tag('mode', 'shared');
    recorder.restore();

    // Then each notice came once the report was readable
    expect(heard).toEqual(['1/0/0', '1/1/0', '1/1/1']);
  });
});
