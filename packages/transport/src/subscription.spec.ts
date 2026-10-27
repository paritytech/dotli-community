// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { str, u8 } from 'scale-ts';
import { describe, expect, it } from 'vitest';
import { decodeOr } from './decodeOr.js';
import { subscription } from './subscription.js';

const watch = subscription({ start: str, receive: u8, interrupt: str });

describe('subscription', () => {
  it('As a transport, I read the leg of a message whose payload does not decode, and of no other', () => {
    // Given an interrupt whose text is cut short, and a message of a leg the method lacks
    const cutShort = Uint8Array.of(2, 8);
    const unknown = Uint8Array.of(9);
    const errors: Error[] = [];
    const onError = (error: Error) => errors.push(error);

    // When
    const whole = decodeOr({ decoder: watch.wholeMessage, data: cutShort, onError });
    const legs = [
      decodeOr({ decoder: watch.leg, data: cutShort, onError }),
      decodeOr({ decoder: watch.leg, data: unknown, onError }),
    ];

    // Then
    expect(whole).toBeUndefined();
    expect(legs[0]).toEqual({ tag: 'interrupt', value: undefined });
    expect(legs[1]).toBeUndefined();
    expect(errors).toHaveLength(2);
  });
});
