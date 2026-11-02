// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { ok } from '../result.js';
import { matchAnyNumber, matchAnyString } from './matchers.js';
import { recordMessage } from './recordMessage.js';
import { deliverEventAndSave } from './deliverEventAndSave.js';
import { createWire } from './createWire.js';
import { vaultSchema } from './vaultSchema.js';

const { save } = vaultSchema.sections.vault;

describe('recordMessage', () => {
  it("As a test, I record a call's message by its section, method and tag, as JSON", async () => {
    // Given the messages of an opener that heard one event and saved once
    const delivered = await deliverEventAndSave();

    // When
    const recorded = delivered.flatMap(data => recordMessage(vaultSchema, data) ?? []);

    // Then
    expect(recorded.filter(message => message.tag === 'receive')).toEqual([
      {
        id: matchAnyNumber(),
        section: 'vault',
        method: 'events',
        tag: 'receive',
        message: matchAnyString(),
        json: JSON.stringify({ tag: 'receive', value: 'synced' }),
      },
    ]);
  });

  it("As a test, I get null for data that is no frame and for the library's own frames", async () => {
    // Given a handshake both sides heard, and bytes too short to hold a frame
    const { opener, delivered } = createWire();
    await opener.whenConnected();
    const data = [...delivered, Uint8Array.of(1, 2)];

    // When
    const recorded = data.map(bytes => recordMessage(vaultSchema, bytes));

    // Then
    expect(delivered.length).toBeGreaterThan(0);
    expect(recorded).toEqual(data.map(() => null));
  });

  it('As a test, I record the bytes of a message as hex, so the record stays plain JSON', async () => {
    // Given an accepter that saves what the opener sends
    const { opener, accepter, delivered } = createWire();
    accepter.handleRequest(save, () => ok());
    await opener.request(save, { entropy: new Uint8Array([1, 2, 255]), amount: 2n ** 100n });

    // When
    const recorded = delivered.flatMap(data => recordMessage(vaultSchema, data) ?? []);

    // Then
    expect(JSON.parse(JSON.stringify(recorded))).toEqual(recorded);
    expect(recorded.find(message => message.tag === 'request')?.json).toBe(
      JSON.stringify({ tag: 'request', value: { entropy: '0x0102ff', amount: (2n ** 100n).toString() } }),
    );
  });
});
