// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { hashBlake2b, fromHex, toHex } from '@dotli/shared';
import type { TruapiSessionUiState } from '../session/parseUiStateCache.js';
import { getMainAccount, type MainAccount } from './mainAccount.js';

const MAIN_KEY = `0x${'a'.repeat(64)}`;
const OWNER = toHex(hashBlake2b(fromHex(MAIN_KEY), 32));

describe('main account', () => {
  it.each<{ name: string; session: TruapiSessionUiState; username: MainAccount['username'] }>([
    {
      name: 'a full username',
      session: { connected: true, publicKey: MAIN_KEY, fullUsername: 'alice.dot', liteUsername: 'alice.01' },
      username: { name: 'alice.dot', kind: 'full' },
    },
    {
      name: 'a lite username alone, its full one empty,',
      session: { connected: true, publicKey: MAIN_KEY, fullUsername: '', liteUsername: 'alice.01' },
      username: { name: 'alice.01', kind: 'lite' },
    },
    { name: 'no username', session: { connected: true, publicKey: MAIN_KEY }, username: null },
  ])('As a site, I sign in for a main account with $name and get that username', ({ session, username }) => {
    // Given a session with that username
    const stored = session;

    // When the window reads the session's main account
    const main = getMainAccount(stored);

    // Then it carries that username
    expect(main).toEqual({ owner: OWNER, username });
  });

  it('As a site, I sign in for a main account whose session has no readable key and get none', () => {
    // Given sessions with no key, and with a key that is not hex
    const keyless = { connected: true, liteUsername: 'alice.01' };
    const unreadable = { connected: true, publicKey: 'not hex' };

    // When the window reads each session's main account
    const read = [getMainAccount(keyless), getMainAccount(unreadable)];

    // Then neither has one
    expect(read).toEqual([null, null]);
  });
});
