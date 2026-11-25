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

    it.each([
      ['no list', null, null],
      ['two rooms and none active', ['a', 'b'], null],
      ['an active room the list does not hold', ['a', 'b'], 'missing'],
    ])('As the chat, I show no room with %s', (_name, roomIds, activeRoomId) => {
      // Given the row's rooms
      const list = roomIds === null ? null : roomIds.map(id => entry(id));

      // When
      const shown = getShownContact(list, activeRoomId);

      // Then
      expect(shown).toBeNull();
    });

    it('As the chat, I show the only room when none is active, with no list behind it', () => {
      // Given one room and none active
      const list = [entry('a')];

      // When
      const shown = getShownContact(list, null);

      // Then
      expect(shown).toEqual({ contact: list[0], sole: true });
    });

    it('As the chat, I show the active room of several, with the list behind it', () => {
      // Given two rooms, the second active
      const list = [entry('a'), entry('b')];

      // When
      const shown = getShownContact(list, 'b');

      // Then
      expect(shown).toEqual({ contact: list[1], sole: false });
    });
  });
});
