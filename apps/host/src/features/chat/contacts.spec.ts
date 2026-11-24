// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ContactEntry } from './contacts.js';
import { contactEntries, getShownContact } from './contacts.js';

describe('contacts', () => {
  it('As a user, contacts are ordered by last message, falling back to creation time', () => {
    // When
    const entries = contactEntries(
      [
        { roomId: 'old', name: 'Old', icon: '', createdAt: 1 },
        { roomId: 'new', name: 'New', icon: '', createdAt: 5 },
      ],
      new Map([['old', 10]]),
    );

    // Then
    expect(entries.map(e => e.id)).toEqual(['old', 'new']);
  });

  it('As a user, a room shows the footer its product set, and a room without one takes text', () => {
    // When
    const entries = contactEntries(
      [
        { roomId: 'quiet', name: 'Quiet', icon: '', createdAt: 2, footer: 'Empty' },
        { roomId: 'plain', name: 'Plain', icon: '', createdAt: 1 },
      ],
      new Map(),
    );

    // Then
    expect(entries.map(e => [e.id, e.footer])).toEqual([
      ['quiet', 'Empty'],
      ['plain', 'TextInput'],
    ]);
  });

  describe('getShownContact', () => {
    const entry = (id: string): ContactEntry => ({
      id,
      name: id,
      icon: '',
      createdAt: 1,
      lastMessageAt: null,
      footer: 'TextInput',
    });
    const one = [entry('a')];
    const two = [entry('a'), entry('b')];

    it.each([
      ['no list', null, null],
      ['no active room and two rooms', two, null],
      ['an active room the list does not hold', two, 'missing'],
    ])('As a user, with %s, no room shows', (_name, list, activeRoomId) => {
      // When
      const shown = getShownContact(list, activeRoomId);

      // Then
      expect(shown?.contact.id).toBeUndefined();
    });

    it('As a user, the only room shows when no room is active, with no list behind it', () => {
      // When
      const shown = getShownContact(one, null);

      // Then
      expect(shown).toEqual({ contact: one[0], sole: true });
    });

    it('As a user, an active room shows with a list behind it when there are several rooms', () => {
      // When
      const shown = getShownContact(two, 'b');

      // Then
      expect(shown).toEqual({ contact: two[1], sole: false });
    });
  });
});
