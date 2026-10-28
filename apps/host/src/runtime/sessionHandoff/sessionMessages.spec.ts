// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  READY,
  createHelloMessage,
  parseHello,
  parsePageMessage,
  parsePayload,
} from './sessionMessages.js';

describe('session messages', () => {
  it('As a site, I say hello to the window and it takes my hello only in its exact shape', () => {
    // Given a valid hello and payloads that break its shape
    const valid = { type: 'dotli:s:hello', v: 1, round: 'r1' };
    const broken = [
      { type: 'dotli:s:hello', round: 'r1' },
      { type: 'dotli:s:hello', v: 1, round: 7 },
      { type: 'dotli:s:ready', v: 1, round: 'r1' },
      null,
    ];

    // When each is parsed
    const parsed = parseHello(valid);
    const rejected = broken.map(parseHello);

    // Then only the valid one parses
    expect(parsed).toEqual(valid);
    expect(rejected).toEqual([null, null, null, null]);
  });

  it('As a user signing in on a dot.li page, I say hello to the window and my hello has the exact shape on the wire', () => {
    // Given the round the page opened the window for
    const round = 'r1';

    // When the page builds its hello
    const hello = createHelloMessage(round);

    // Then it is the wire's hello for that round
    expect(hello).toEqual({ type: 'dotli:s:hello', v: 1, round: 'r1' });
  });

  it('As a site, I send my payload to the sign window and it takes the payload only in its exact shape', () => {
    // Given a valid payload and messages that break its shape
    const valid = { type: 'dotli:s:payload', round: 'r1', call: '0x0001' };
    const broken = [
      { type: 'dotli:s:payload', round: 'r1', call: 7 },
      { type: 'dotli:s:payload', round: 'r1' },
      { type: 'dotli:s:payload', round: 1, call: '0x0001' },
      { type: 'dotli:s:hello', round: 'r1', call: '0x0001' },
      null,
    ];

    // When each is parsed
    const parsed = parsePayload({ ...valid, extra: true });
    const rejected = broken.map(parsePayload);

    // Then only the valid one parses, to its three fields
    expect(parsed).toEqual(valid);
    expect(rejected).toEqual(broken.map(() => null));
  });

  it('As a user signing in on a dot.li page, I hear ready, result and refused from the window and the page rejects everything else', () => {
    // Given the three messages and payloads that are none of them
    const ready = { type: 'dotli:s:ready', versions: [1] };
    const result = { type: 'dotli:s:result', round: 'r1', result: null };
    const refused = { type: 'dotli:s:refused', round: 'r1', reason: 'origin_not_allowed' };
    const others = [
      { type: 'dotli:s:hello', v: 1, round: 'r1' },
      { type: 'dotli:s:ready', versions: ['1'] },
      { type: 'dotli:s:ready' },
      { type: 'dotli:s:result', round: 'r1' },
      { type: 'dotli:s:result', round: 1, result: 1 },
      { type: 'dotli:s:refused', round: 'r1' },
      'dotli:s:ready',
    ];

    // When each is parsed
    const parsed = [ready, result, refused].map(parsePageMessage);
    const rejected = others.map(parsePageMessage);

    // Then the three parse and the rest do not
    expect(parsed).toEqual([ready, result, refused]);
    expect(rejected).toEqual(others.map(() => null));
  });

  it('As a site, I hear a cancel and a result that carries a site token and read both unchanged', () => {
    // Given a cancel and a result with a site token
    const cancelled = { type: 'dotli:s:cancelled', round: 'r1' };
    const result = { type: 'dotli:s:result', round: 'r1', result: null, site_token: 'tok' };

    // When each is parsed
    const parsed = [cancelled, result].map(parsePageMessage);

    // Then both read back unchanged
    expect(parsed).toEqual([cancelled, result]);
  });

  it.each([
    { name: 'a cancel without its round', message: { type: 'dotli:s:cancelled' } },
    { name: 'a cancel with a non-string round', message: { type: 'dotli:s:cancelled', round: 1 } },
    {
      name: 'a result with a non-string site token',
      message: { type: 'dotli:s:result', round: 'r1', result: null, site_token: 7 },
    },
  ])('As a site, I hear $name and reject it', row => {
    // Given the broken message
    const data = row.message;

    // When it is parsed
    const parsed = parsePageMessage(data);

    // Then it is rejected
    expect(parsed).toBeNull();
  });

  it('As a site, I hear the window announce its version in its ready and read that version', () => {
    // Given the window's ready
    const ready = READY;

    // When the site parses it
    const parsed = parsePageMessage(ready);

    // Then it names the version
    expect(parsed).toEqual({ type: 'dotli:s:ready', versions: [PROTOCOL_VERSION] });
  });
});
