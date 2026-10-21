// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { contactEntries } from './contacts.js';

describe('contacts', () => {
  it('As a user, contacts are ordered by last message, falling back to creation time', () => {
    // When
    const entries = contactEntries(
      [
        { roomId: 'old', name: 'Old', icon: '', createdAt: 1 },
        { roomId: 'new', name: 'New', icon: '', createdAt: 5 },
      ],
      [{ botId: 'bot', name: 'Bot', icon: '', createdAt: 3 }],
      new Map([['old', 10]]),
    );

    // Then
    expect(entries.map(e => [e.kind, e.id])).toEqual([
      ['room', 'old'],
      ['room', 'new'],
      ['bot', 'bot'],
    ]);
  });

  it('As a user, a room shows the footer its product set, and a room or bot without one takes text', () => {
    // When
    const entries = contactEntries(
      [
        { roomId: 'quiet', name: 'Quiet', icon: '', createdAt: 2, footer: 'Empty' },
        { roomId: 'plain', name: 'Plain', icon: '', createdAt: 1 },
      ],
      [{ botId: 'bot', name: 'Bot', icon: '', createdAt: 0 }],
      new Map(),
    );

    // Then
    expect(entries.map(e => [e.id, e.footer])).toEqual([
      ['quiet', 'Empty'],
      ['plain', 'TextInput'],
      ['bot', 'TextInput'],
    ]);
  });
});
