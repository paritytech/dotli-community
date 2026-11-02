// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { moreLabel, worstTone } from './alerts.js';

const syncing = { tone: 'idle', label: 'network syncing' } as const;
const unread = { tone: 'info', label: 'chat has unread messages' } as const;
const offline = { tone: 'err', label: 'network offline' } as const;

describe('More alerts', () => {
  it('As a phone user with several collapsed items raising a status, I look at More and see the most severe one as its badge', () => {
    // Given
    const quiet = [syncing, unread];
    const failing = [offline, unread];

    // When
    const quietTone = worstTone(quiet);
    const failingTone = worstTone(failing);

    // Then
    expect(quietTone).toBe('info');
    expect(failingTone).toBe('err');
  });

  it('As a screen-reader user, I reach More and hear every raised status in row order', () => {
    // Given
    const raised = [offline, unread];

    // When
    const label = moreLabel(raised);

    // Then
    expect(label).toBe('More, network offline, chat has unread messages');
  });

  it('As a user whose collapsed items raise nothing, I look at More and see no badge and the name More', () => {
    // When
    const tone = worstTone([]);
    const label = moreLabel([]);

    // Then
    expect(tone).toBeUndefined();
    expect(label).toBe('More');
  });
});
