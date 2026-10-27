// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { domain } from './callError.js';
import { cancelled, denied, hostFailure, malformedFrame, unsupported } from './failure.js';

describe('callError', () => {
  it('As a handler, I build each CallError variant with its constructor and get its tag and value', () => {
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
});
