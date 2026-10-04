// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindTopbarStatus } from '../src/topbar-status.js';
import { resetStores } from './helpers/solid.js';

let unbind: (() => void) | null = null;

afterEach(() => {
  unbind?.();
  unbind = null;
  resetStores();
  vi.restoreAllMocks();
});

describe('bindTopbarStatus, before the rest of the shell boots', () => {
  it('As a user going offline while the page still boots, the capsule turns red at once', () => {
    // Given: nothing but the bar's own script has run
    const bar = document.createElement('header');
    unbind = bindTopbarStatus(bar);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    // When
    window.dispatchEvent(new Event('offline'));

    // Then
    expect(bar.dataset['health']).toBe('offline');
  });
});
