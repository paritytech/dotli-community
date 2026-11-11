// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { readMessages } from './readMessages.js';
import { recordMessage } from './recordMessage.js';
import { deliverEventAndSave } from './deliverEventAndSave.js';
import { vaultSchema } from './vaultSchema.js';

const { events } = vaultSchema.sections.vault;

describe('readMessages', () => {
  it("As a test, I read one method's recorded messages decoded with it, and skip the other methods'", async () => {
    // Given a recording of one event and one save
    const recorded = (await deliverEventAndSave()).flatMap(data => recordMessage(vaultSchema, data) ?? []);

    // When
    const messages = readMessages({ schema: vaultSchema, method: events, recorded });

    // Then
    expect(messages).toEqual([
      { tag: 'start', value: undefined },
      { tag: 'receive', value: 'synced' },
    ]);
  });
});
