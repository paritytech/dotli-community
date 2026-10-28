// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { SharedChannel } from '../sharedMode.js';
import { memorySharedChannel } from '../sharedMode.fake.js';
import { createStorePresence } from './createStorePresence.js';

describe('store presence', () => {
  it('As a developer on a local page, I set and clear the flag and read present after the set and absent after the clear', async () => {
    // Given a flag over a working dev store
    const presence = createStorePresence(memorySharedChannel());

    // When the flag is set, read and cleared
    void presence.set();
    const afterSet = await presence.read();
    void presence.clear();
    const afterClear = await presence.read();

    // Then it read present after the set and absent after the clear
    expect([afterSet, afterClear]).toEqual(['present', 'absent']);
  });

  it('As a developer on a local page, I renew a flag the dev store holds and nothing is sent', async () => {
    // Given a dev store that holds the flag and records every read, write and clear
    const sent: string[] = [];
    const channel: SharedChannel = {
      read(key) {
        sent.push(`read ${key}`);
        return Promise.resolve('1');
      },
      write(key) {
        sent.push(`write ${key}`);
        return Promise.resolve();
      },
      clear(key) {
        sent.push(`clear ${key}`);
        return Promise.resolve();
      },
    };

    // When the flag is renewed
    await createStorePresence(channel).renew();

    // Then nothing was sent
    expect(sent).toEqual([]);
  });
});
