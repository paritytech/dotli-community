// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { log } from '../log.js';
import { recordLog } from './record-log.js';

describe('recordLog', () => {
  it('As a spec, I read what the log wrote at one level until my test ends, and the sink before is back after', () => {
    // Given
    const restores: (() => void)[] = [];
    const errors = recordLog({ onFinished: restore => restores.push(restore), level: 'error' });

    // When
    log.warn('slow');
    log.error('broke');
    for (const restore of restores) {
      restore();
    }
    log.error('after');

    // Then
    expect(errors.map(line => line.message)).toEqual(['broke']);
  });
});
