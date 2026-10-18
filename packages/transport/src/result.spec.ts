// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { cancelled, denied, domain, err, hostFailure, malformedFrame, ok, unsupported } from './result.js';

describe('result', () => {
  it('As a caller, I tell ok from err by its success, as scale-ts reads a Result', () => {
    // Given
    const good = ok(7);
    const bad = err('nope');

    // When
    const empty = ok();

    // Then
    expect(good).toEqual({ success: true, value: 7 });
    expect(bad).toEqual({ success: false, value: 'nope' });
    expect(empty).toEqual({ success: true, value: undefined });
  });

  it('As a handler, I build each CallError variant with its constructor', () => {
    // Given
    const reason = 'bad bytes';

    // When
    const all = [domain(3), denied(), unsupported(), malformedFrame(reason), hostFailure(reason), cancelled()];

    // Then
    expect(all).toEqual([
      { tag: 'Domain', value: 3 },
      { tag: 'Denied', value: undefined },
      { tag: 'Unsupported', value: undefined },
      { tag: 'MalformedFrame', value: { reason } },
      { tag: 'HostFailure', value: { reason } },
      { tag: 'Cancelled', value: undefined },
    ]);
  });

  it('As a handler, I fail a call with an error as a handler that throws it would, so the caller reads its name', () => {
    // Given
    const thrown = new TypeError('bad label');
    const long = new Error('x'.repeat(600));

    // When
    const failures = [hostFailure(thrown), hostFailure(long)];

    // Then
    expect(failures).toEqual([
      { tag: 'HostFailure', value: { reason: 'TypeError: bad label' } },
      { tag: 'HostFailure', value: { reason: `Error: ${'x'.repeat(493)}` } },
    ]);
  });
});
