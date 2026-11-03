// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { prepareQrCode } from './qrCode.js';

describe('prepareQrCode', () => {
  it('As a user who starts signing in, I see the spinner and the QR encoder starts loading', () => {
    // Given a load of the QR encoder that resolves
    const load = vi.fn(() => Promise.resolve({}));

    // When the pairing view prepares the code
    prepareQrCode(load);

    // Then the encoder started loading once
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('As a user whose QR encoder fails to load early, I see the spinner and nothing fails until the code is drawn', () => {
    // Given a load of the QR encoder that rejects
    const load = vi.fn(() => Promise.reject(new Error('chunk miss')));

    // When the pairing view prepares the code
    prepareQrCode(load);

    // Then the encoder started loading once. The rejected promise is neither kept nor awaited here, since Vitest fails
    // the run on an unhandled rejection, which is the check that `prepareQrCode` handled it.
    expect(load).toHaveBeenCalledTimes(1);
  });
});
