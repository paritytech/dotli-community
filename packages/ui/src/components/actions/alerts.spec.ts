// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { moreLabel, worstTone } from './alerts.js';

const syncing = { tone: 'idle', label: 'network syncing' } as const;
const unread = { tone: 'info', label: 'chat has unread messages' } as const;
const offline = { tone: 'err', label: 'network offline' } as const;

describe('More alerts', () => {
  it('As a phone user with several collapsed items raising a status, I see the most severe one as the More badge', () => {
    // Given
    const raised = [syncing, unread];

    // When
    const tone = worstTone(raised);

    // Then
    expect(tone).toBe('info');
    expect(worstTone([offline, unread])).toBe('err');
  });

  it('As a screen-reader user, I hear every raised status in More, in row order', () => {
    // Given
    const raised = [offline, unread];

    // When
    const label = moreLabel(raised);

    // Then
    expect(label).toBe('More, network offline, chat has unread messages');
  });

  it('As a user whose collapsed items raise nothing, More has no badge and is named More', () => {
    // When
    const tone = worstTone([]);

    // Then
    expect(tone).toBeUndefined();
    expect(moreLabel([])).toBe('More');
  });
});
