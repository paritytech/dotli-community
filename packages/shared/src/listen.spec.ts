// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { listen } from './listen.js';

describe('listen', () => {
  it('As a developer, I listen and hear each event until I stop with the stop it gave me', () => {
    // Given a listener on a target
    const target = new EventTarget();
    const handler = vi.fn();
    const stop = listen({ target, type: 'ping', handler });

    // When an event fires, the listener stops and another fires
    target.dispatchEvent(new Event('ping'));
    stop();
    target.dispatchEvent(new Event('ping'));

    // Then only the first was heard
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
